use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};

use margent_core::change_set::{
    apply_selected_hunks, build_review_change_set, ChangeSource, ReviewChangeSet,
};

use crate::models::adapter::AdapterDefinition;
use crate::models::document::{DocumentRecord, DocumentVersion};
use crate::models::proposal::{
    ProposalChangeSetResult, ProposalHunkAcceptResult, ProposalMutationResult, ProposalRecord,
};
use crate::models::thread::ThreadRecord;

use super::{adapter_service, diff_service, file_service, thread_service, workspace_service};

const STALE_PROPOSAL_WARNING: &str =
    "This proposal targets an older saved document hash and should be regenerated.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterResponse {
    status: String,
    response_mode: String,
    assistant_message: Option<String>,
    updated_document_text: Option<String>,
    unified_diff: Option<String>,
    resolve_thread_ids: Option<Vec<String>>,
    warnings: Option<Vec<String>>,
}

#[cfg(debug_assertions)]
struct DebugTiming {
    label: &'static str,
    start: Instant,
}

#[cfg(not(debug_assertions))]
struct DebugTiming;

impl DebugTiming {
    #[cfg(debug_assertions)]
    fn new(label: &'static str) -> Self {
        Self {
            label,
            start: Instant::now(),
        }
    }

    #[cfg(not(debug_assertions))]
    fn new(_label: &'static str) -> Self {
        Self
    }

    #[cfg(debug_assertions)]
    fn mark(&self, step: &str) {
        eprintln!(
            "[margent timing] {}: {} at {:.1}ms",
            self.label,
            step,
            self.start.elapsed().as_secs_f64() * 1000.0
        );
    }

    #[cfg(not(debug_assertions))]
    fn mark(&self, _step: &str) {}
}

pub fn load_proposals(
    workspace_root: &str,
    document_id: &str,
) -> Result<Vec<ProposalRecord>, String> {
    let root_path = Path::new(workspace_root);
    refresh_pending_proposals_for_document(root_path, document_id, None)?;
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let proposals_dir = mdreview_path.join("proposals");
    let mut proposals = Vec::new();

    for entry in fs::read_dir(&proposals_dir)
        .map_err(|error| format!("Unable to read {}: {error}", proposals_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to inspect proposal records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if let Some(proposal) = read_scanned_sidecar::<ProposalRecord>(&path, "proposal")? {
            if proposal.document_id == document_id {
                proposals.push(compact_terminal_proposal_for_response(proposal));
            }
        }
    }

    proposals.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(proposals)
}

pub fn load_all_proposals(workspace_root: &str) -> Result<Vec<ProposalRecord>, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let documents_dir = mdreview_path.join("documents");

    for entry in fs::read_dir(&documents_dir)
        .map_err(|error| format!("Unable to read {}: {error}", documents_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to inspect document records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if let Some(document) = read_scanned_sidecar::<DocumentRecord>(&path, "document")? {
            refresh_pending_proposals_for_document(root_path, &document.id, None)?;
        }
    }

    let proposals_dir = mdreview_path.join("proposals");
    let mut proposals = Vec::new();

    for entry in fs::read_dir(&proposals_dir)
        .map_err(|error| format!("Unable to read {}: {error}", proposals_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to inspect proposal records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if let Some(proposal) = read_scanned_sidecar::<ProposalRecord>(&path, "proposal")? {
            proposals.push(compact_terminal_proposal_for_response(proposal));
        }
    }

    proposals.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(proposals)
}

pub fn get_proposal_change_set(
    workspace_root: &str,
    proposal_id: &str,
) -> Result<ProposalChangeSetResult, String> {
    let root_path = Path::new(workspace_root);
    let proposal = load_proposal_record(root_path, proposal_id)?;
    let updated_document_text = match proposal.updated_document_text.clone() {
        Some(text) => text,
        None => {
            return Ok(ProposalChangeSetResult::Unsupported {
                proposal: Box::new(proposal),
                message: "Only updated-document proposals can be reviewed as hunks.".into(),
            })
        }
    };
    let (document_record, document_path, current_document_text) =
        load_document_context(root_path, &proposal.document_id)?;
    let current_hash = file_service::content_hash(&current_document_text);

    if proposal.base_content_hash != current_hash {
        return Ok(ProposalChangeSetResult::Stale {
            proposal: Box::new(proposal),
            message:
                "The document changed after this proposal was generated; regenerate the proposal."
                    .into(),
        });
    }

    let change_set = proposal_change_set(
        &proposal,
        &document_record,
        &current_document_text,
        &updated_document_text,
    );
    let document_version = workspace_service::document_version_for_path_and_content(
        &document_path,
        &current_document_text,
    )?;

    Ok(ProposalChangeSetResult::Ready {
        proposal: Box::new(proposal),
        change_set: Box::new(change_set),
        document_version,
    })
}

pub fn accept_proposal_hunks(
    workspace_root: &str,
    proposal_id: &str,
    selected_hunk_ids: Vec<String>,
    expected_document_version: &DocumentVersion,
) -> Result<ProposalHunkAcceptResult, String> {
    let timing = DebugTiming::new("accept_proposal_hunks");
    if selected_hunk_ids.is_empty() {
        return Err("Select at least one hunk to apply.".into());
    }

    let root_path = Path::new(workspace_root);
    let proposal = load_proposal_record(root_path, proposal_id)?;
    timing.mark("load proposal");
    let updated_document_text = proposal
        .updated_document_text
        .clone()
        .ok_or_else(|| "Only updated-document proposals can be accepted as hunks.".to_string())?;
    let (document_record, document_path, current_document_text) =
        load_document_context(root_path, &proposal.document_id)?;
    timing.mark("load document context");
    let actual_version = workspace_service::document_version_for_path_and_content(
        &document_path,
        &current_document_text,
    )?;
    timing.mark("document version");

    if &actual_version != expected_document_version {
        return Ok(ProposalHunkAcceptResult::Conflict {
            expected_version: expected_document_version.clone(),
            actual_version,
            message: "The document changed on disk before the selected hunks could be applied."
                .into(),
        });
    }

    let current_hash = file_service::content_hash(&current_document_text);
    timing.mark("hash current document");
    if proposal.base_content_hash != current_hash {
        let mut stale_proposal = proposal.clone();
        mark_proposal_stale(root_path, &mut stale_proposal)?;
        return Ok(ProposalHunkAcceptResult::Stale {
            proposal: Box::new(compact_terminal_proposal_for_response(stale_proposal)),
            message:
                "The document changed after this proposal was generated; the proposal was marked stale."
                    .into(),
        });
    }

    let change_set = proposal_change_set(
        &proposal,
        &document_record,
        &current_document_text,
        &updated_document_text,
    );
    timing.mark("build change set");
    let applied_text = apply_selected_hunks(
        &current_document_text,
        &change_set,
        selected_hunk_ids.iter(),
    )?;
    timing.mark("apply selected hunks");
    let result = accept_proposal(workspace_root, proposal_id, Some(applied_text))?;
    timing.mark("accept proposal");

    Ok(ProposalHunkAcceptResult::Applied {
        result: Box::new(result),
        applied_hunk_ids: selected_hunk_ids,
    })
}

pub fn accept_proposal(
    workspace_root: &str,
    proposal_id: &str,
    edited_document_text: Option<String>,
) -> Result<ProposalMutationResult, String> {
    let timing = DebugTiming::new("accept_proposal");
    let root_path = Path::new(workspace_root);
    let mut proposal = load_proposal_record(root_path, proposal_id)?;
    timing.mark("load proposal");

    match proposal.status.as_str() {
        "accepted" => return Err("Proposal has already been accepted.".into()),
        "rejected" => return Err("Rejected proposals cannot be accepted.".into()),
        "failed" => return Err("Failed proposals cannot be accepted.".into()),
        "stale" => {
            return Ok(ProposalMutationResult {
                proposal: compact_terminal_proposal_for_response(proposal),
                document: None,
                snapshot: None,
                message: Some(
                    "This proposal targets an older version of the document and can no longer be applied."
                        .into(),
                ),
            })
        }
        "pending" => {}
        other => return Err(format!("Unsupported proposal status {other}.")),
    }

    let (document_record, _, current_document_text) =
        load_document_context(root_path, &proposal.document_id)?;
    timing.mark("load document context");
    let current_content_hash = file_service::content_hash(&current_document_text);
    timing.mark("hash current document");

    if proposal.base_content_hash != current_content_hash {
        mark_proposal_stale(root_path, &mut proposal)?;

        return Ok(ProposalMutationResult {
            proposal: compact_terminal_proposal_for_response(proposal),
            document: None,
            snapshot: None,
            message: Some(
                "The document changed after this proposal was generated, so it was marked stale instead of being applied."
                    .into(),
            ),
        });
    }

    let edited_at_accept = edited_document_text.is_some();
    let updated_document_text = edited_document_text
        .or_else(|| proposal.updated_document_text.clone())
        .ok_or_else(|| {
            "Only updated-document proposals can be accepted in the current release.".to_string()
        })?;
    let snapshot = workspace_service::snapshot_document(
        root_path,
        &document_record,
        &current_document_text,
        "proposal.accept",
        Some(&proposal.id),
    )?;
    timing.mark("snapshot document");
    let document = workspace_service::save_document_after_proposal_accept(
        workspace_root,
        &document_record.relative_path,
        &updated_document_text,
    )?;
    timing.mark("save document");

    if proposal.updated_document_text.as_deref() != Some(updated_document_text.as_str()) {
        proposal.computed_diff =
            diff_service::compute_unified_diff(&current_document_text, &updated_document_text);
        proposal.updated_document_text = Some(updated_document_text.clone());
        proposal.unified_diff = None;
        timing.mark("compute edited diff");
    }
    proposal.status = "accepted".into();
    proposal.updated_at = file_service::now_rfc3339()?;
    save_proposal_record(root_path, &proposal)?;
    timing.mark("save proposal");
    record_authorship_for_acceptance(
        root_path,
        &document_record,
        &current_document_text,
        &updated_document_text,
        &proposal,
        edited_at_accept,
        &proposal.updated_at,
    )?;
    timing.mark("record authorship");
    append_proposal_event_for_record(root_path, "proposal.accepted", &proposal)?;
    timing.mark("append event");
    resolve_threads_for_acceptance(workspace_root, &proposal.resolve_thread_ids)?;
    timing.mark("resolve threads");
    refresh_pending_proposals_for_document(root_path, &proposal.document_id, Some(&proposal.id))?;
    timing.mark("refresh pending proposals");

    Ok(ProposalMutationResult {
        proposal: compact_terminal_proposal_for_response(proposal),
        document: Some(document),
        snapshot: Some(snapshot),
        message: None,
    })
}

pub fn reject_proposal(
    workspace_root: &str,
    proposal_id: &str,
) -> Result<ProposalMutationResult, String> {
    let root_path = Path::new(workspace_root);
    let mut proposal = load_proposal_record(root_path, proposal_id)?;

    match proposal.status.as_str() {
        "accepted" => return Err("Accepted proposals cannot be rejected.".into()),
        "rejected" => return Err("Proposal has already been rejected.".into()),
        "failed" => return Err("Failed proposals cannot be rejected.".into()),
        "pending" | "stale" => {}
        other => return Err(format!("Unsupported proposal status {other}.")),
    }

    proposal.status = "rejected".into();
    proposal.updated_at = file_service::now_rfc3339()?;
    save_proposal_record(root_path, &proposal)?;
    append_proposal_event_for_record(root_path, "proposal.rejected", &proposal)?;

    Ok(ProposalMutationResult {
        proposal: compact_terminal_proposal_for_response(proposal),
        document: None,
        snapshot: None,
        message: None,
    })
}

pub fn request_proposal(
    workspace_root: &str,
    document_id: &str,
    thread_id: &str,
    adapter_id: &str,
    instructions: &str,
) -> Result<ProposalRecord, String> {
    let root_path = Path::new(workspace_root);
    let (document_record, document_path, document_content) =
        load_document_context(root_path, document_id)?;
    let mut thread = thread_service::load_thread_record(root_path, thread_id)?;

    if thread.document_id != document_id {
        return Err(format!(
            "Thread {thread_id} does not belong to document {}.",
            document_record.relative_path
        ));
    }

    let adapter = adapter_service::find_adapter(workspace_root, adapter_id)?
        .ok_or_else(|| format!("Adapter {adapter_id} was not found in .mdreview/adapters.json."))?;
    let proposal_id = next_id("proposal")?;
    let now = file_service::now_rfc3339()?;

    append_proposal_event(
        root_path,
        "proposal.requested",
        &proposal_id,
        &thread.id,
        document_id,
        Some(adapter.id.as_str()),
    )?;

    if matches!(thread.anchor.state.as_str(), "detached" | "needs_review") {
        let proposal = build_failed_proposal(
            &proposal_id,
            &now,
            &document_record,
            &thread,
            &adapter,
            "Thread anchor is not reliable enough for adapter targeting yet.",
            Vec::new(),
            None,
        );
        persist_proposal(root_path, &mut thread, &proposal)?;
        append_proposal_event(
            root_path,
            "proposal.failed",
            &proposal.id,
            &thread.id,
            document_id,
            Some(adapter.id.as_str()),
        )?;
        return Ok(proposal);
    }

    let request_value = build_request_payload(
        workspace_root,
        &document_record,
        &document_content,
        &thread,
        instructions,
    );
    let request_json = serde_json::to_string_pretty(&request_value)
        .map_err(|error| format!("Unable to serialize proposal request: {error}"))?;

    let execution = match adapter_service::execute_adapter(
        &adapter,
        root_path,
        &document_path,
        &request_json,
    ) {
        Ok(execution) => execution,
        Err(error) => {
            let proposal = build_failed_proposal(
                &proposal_id,
                &now,
                &document_record,
                &thread,
                &adapter,
                &error,
                Vec::new(),
                None,
            );
            persist_proposal(root_path, &mut thread, &proposal)?;
            append_proposal_event(
                root_path,
                "proposal.failed",
                &proposal.id,
                &thread.id,
                document_id,
                Some(adapter.id.as_str()),
            )?;
            return Ok(proposal);
        }
    };

    if execution.timed_out {
        let proposal = build_failed_proposal(
            &proposal_id,
            &now,
            &document_record,
            &thread,
            &adapter,
            "Adapter timed out before producing a valid response.",
            Vec::new(),
            some_stderr(execution.stderr),
        );
        persist_proposal(root_path, &mut thread, &proposal)?;
        append_proposal_event(
            root_path,
            "proposal.failed",
            &proposal.id,
            &thread.id,
            document_id,
            Some(adapter.id.as_str()),
        )?;
        return Ok(proposal);
    }

    if execution.exit_code != 0 {
        let proposal = build_failed_proposal(
            &proposal_id,
            &now,
            &document_record,
            &thread,
            &adapter,
            &format!("Adapter exited with status {}.", execution.exit_code),
            Vec::new(),
            some_stderr(execution.stderr),
        );
        persist_proposal(root_path, &mut thread, &proposal)?;
        append_proposal_event(
            root_path,
            "proposal.failed",
            &proposal.id,
            &thread.id,
            document_id,
            Some(adapter.id.as_str()),
        )?;
        return Ok(proposal);
    }

    let response: AdapterResponse = match serde_json::from_str(&execution.stdout) {
        Ok(response) => response,
        Err(error) => {
            let proposal = build_failed_proposal(
                &proposal_id,
                &now,
                &document_record,
                &thread,
                &adapter,
                &format!("Adapter stdout was not valid JSON: {error}"),
                Vec::new(),
                some_stderr(execution.stderr),
            );
            persist_proposal(root_path, &mut thread, &proposal)?;
            append_proposal_event(
                root_path,
                "proposal.failed",
                &proposal.id,
                &thread.id,
                document_id,
                Some(adapter.id.as_str()),
            )?;
            return Ok(proposal);
        }
    };

    let proposal = match response.status.as_str() {
        "ok" => build_success_proposal(
            &proposal_id,
            &now,
            &document_record,
            &thread,
            &adapter,
            &document_content,
            response,
            some_stderr(execution.stderr),
        ),
        _ => Ok(build_failed_proposal(
            &proposal_id,
            &now,
            &document_record,
            &thread,
            &adapter,
            "Adapter reported a failed status.",
            response.warnings.unwrap_or_default(),
            some_stderr(execution.stderr),
        )),
    }?;

    let event_type = if proposal.status == "failed" {
        "proposal.failed"
    } else {
        "proposal.received"
    };

    persist_proposal(root_path, &mut thread, &proposal)?;
    append_proposal_event(
        root_path,
        event_type,
        &proposal.id,
        &thread.id,
        document_id,
        Some(adapter.id.as_str()),
    )?;

    Ok(proposal)
}

fn build_request_payload(
    workspace_root: &str,
    document_record: &DocumentRecord,
    document_content: &str,
    thread: &ThreadRecord,
    instructions: &str,
) -> Value {
    json!({
        "schemaVersion": 1,
        "task": "propose_revision",
        "workspaceRoot": workspace_root,
        "document": {
            "id": document_record.id,
            "relativePath": document_record.relative_path,
            "content": document_content,
            "contentHash": document_record.current_content_hash,
            "selection": {
                "startOffsetUtf16": thread.anchor.start_offset_utf16,
                "endOffsetUtf16": thread.anchor.end_offset_utf16,
            }
        },
        "thread": {
            "id": thread.id,
            "status": thread.status,
            "anchor": {
                "quote": thread.anchor.quote,
                "state": thread.anchor.state,
                "confidence": thread.anchor.confidence,
            },
            "messages": thread.messages.iter().map(|message| {
                json!({
                    "authorType": message.author_type,
                    "body": message.body,
                })
            }).collect::<Vec<_>>()
        },
        "relatedThreads": [],
        "instructions": if instructions.trim().is_empty() {
            "Revise only what is necessary to address the selected thread."
        } else {
            instructions.trim()
        },
        "preferredResponseMode": "updated_document"
    })
}

#[allow(clippy::too_many_arguments)]
fn build_success_proposal(
    proposal_id: &str,
    timestamp: &str,
    document_record: &DocumentRecord,
    thread: &ThreadRecord,
    adapter: &AdapterDefinition,
    document_content: &str,
    response: AdapterResponse,
    stderr: Option<String>,
) -> Result<ProposalRecord, String> {
    let assistant_message = response.assistant_message.unwrap_or_default();
    let warnings = response.warnings.unwrap_or_default();
    let resolve_thread_ids = response.resolve_thread_ids.unwrap_or_default();
    let response_mode = response.response_mode.clone();

    match response.response_mode.as_str() {
        "updated_document" => {
            let updated_document_text = response.updated_document_text.ok_or_else(|| {
                "Adapter responseMode=updated_document but no updatedDocumentText was returned."
                    .to_string()
            })?;

            if updated_document_text == document_content {
                return Ok(build_failed_proposal(
                    proposal_id,
                    timestamp,
                    document_record,
                    thread,
                    adapter,
                    "Adapter returned a no-op document.",
                    warnings,
                    stderr,
                ));
            }

            let computed_diff =
                diff_service::compute_unified_diff(document_content, &updated_document_text);

            Ok(ProposalRecord {
                schema_version: 1,
                id: proposal_id.to_string(),
                document_id: document_record.id.clone(),
                thread_ids: vec![thread.id.clone()],
                adapter_id: adapter.id.clone(),
                created_at: timestamp.to_string(),
                updated_at: timestamp.to_string(),
                status: "pending".into(),
                base_content_hash: document_record.current_content_hash.clone(),
                response_mode,
                summary: summarize_proposal(&assistant_message, &adapter.name),
                assistant_message,
                updated_document_text: Some(updated_document_text),
                unified_diff: None,
                computed_diff,
                warnings,
                resolve_thread_ids,
                stderr,
                error_message: None,
                extra: Default::default(),
            })
        }
        "unified_diff" => {
            let unified_diff = response.unified_diff.ok_or_else(|| {
                "Adapter responseMode=unified_diff but no unifiedDiff was returned.".to_string()
            })?;

            Ok(ProposalRecord {
                schema_version: 1,
                id: proposal_id.to_string(),
                document_id: document_record.id.clone(),
                thread_ids: vec![thread.id.clone()],
                adapter_id: adapter.id.clone(),
                created_at: timestamp.to_string(),
                updated_at: timestamp.to_string(),
                status: "pending".into(),
                base_content_hash: document_record.current_content_hash.clone(),
                response_mode,
                summary: summarize_proposal(&assistant_message, &adapter.name),
                assistant_message,
                updated_document_text: None,
                unified_diff: Some(unified_diff.clone()),
                computed_diff: unified_diff,
                warnings,
                resolve_thread_ids,
                stderr,
                error_message: None,
                extra: Default::default(),
            })
        }
        unsupported => Ok(build_failed_proposal(
            proposal_id,
            timestamp,
            document_record,
            thread,
            adapter,
            &format!("Unsupported responseMode {unsupported}."),
            warnings,
            stderr,
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_failed_proposal(
    proposal_id: &str,
    timestamp: &str,
    document_record: &DocumentRecord,
    thread: &ThreadRecord,
    adapter: &AdapterDefinition,
    error_message: &str,
    mut warnings: Vec<String>,
    stderr: Option<String>,
) -> ProposalRecord {
    if let Some(stderr_text) = stderr.as_ref() {
        warnings.push(format!("stderr: {stderr_text}"));
    }

    ProposalRecord {
        schema_version: 1,
        id: proposal_id.to_string(),
        document_id: document_record.id.clone(),
        thread_ids: vec![thread.id.clone()],
        adapter_id: adapter.id.clone(),
        created_at: timestamp.to_string(),
        updated_at: timestamp.to_string(),
        status: "failed".into(),
        base_content_hash: document_record.current_content_hash.clone(),
        response_mode: "none".into(),
        summary: format!("{} failed", adapter.name),
        assistant_message: String::new(),
        updated_document_text: None,
        unified_diff: None,
        computed_diff: String::new(),
        warnings,
        resolve_thread_ids: Vec::new(),
        stderr,
        error_message: Some(error_message.to_string()),
        extra: Default::default(),
    }
}

fn persist_proposal(
    workspace_root: &Path,
    thread: &mut ThreadRecord,
    proposal: &ProposalRecord,
) -> Result<(), String> {
    save_proposal_record(workspace_root, proposal)?;

    if !thread
        .linked_proposal_ids
        .iter()
        .any(|id| id == &proposal.id)
    {
        thread.linked_proposal_ids.push(proposal.id.clone());
        thread_service::save_thread_record(workspace_root, thread)?;
    }

    Ok(())
}

fn load_proposal_record(
    workspace_root: &Path,
    proposal_id: &str,
) -> Result<ProposalRecord, String> {
    let proposal_path = proposal_path(workspace_root, proposal_id)?;
    file_service::read_optional_json::<ProposalRecord>(&proposal_path)?
        .ok_or_else(|| format!("Proposal {proposal_id} was not found."))
}

fn save_proposal_record(workspace_root: &Path, proposal: &ProposalRecord) -> Result<(), String> {
    let proposal_path = proposal_path(workspace_root, &proposal.id)?;
    file_service::write_json_atomic(&proposal_path, proposal)
}

fn proposal_change_set(
    proposal: &ProposalRecord,
    document: &DocumentRecord,
    before: &str,
    after: &str,
) -> ReviewChangeSet {
    let mut change_set = build_review_change_set(
        &document.id,
        ChangeSource {
            kind: "proposal".into(),
            id: Some(proposal.id.clone()),
        },
        before,
        after,
    );
    change_set.base_hash = Some(proposal.base_content_hash.clone());
    change_set
}

fn compact_terminal_proposal_for_response(mut proposal: ProposalRecord) -> ProposalRecord {
    if proposal.status != "pending" {
        proposal.updated_document_text = None;
        proposal.unified_diff = None;
        proposal.computed_diff.clear();
        proposal.stderr = None;
    }

    proposal
}

fn read_scanned_sidecar<T>(path: &Path, sidecar_kind: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned,
{
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Unable to read {}: {error}", path.display())),
    };

    match serde_json::from_str(&text) {
        Ok(record) => Ok(Some(record)),
        Err(error) => {
            eprintln!(
                "Warning: skipping corrupt {sidecar_kind} sidecar {}: {error}",
                path.display()
            );
            Ok(None)
        }
    }
}

fn record_authorship_for_acceptance(
    workspace_root: &Path,
    document: &DocumentRecord,
    before: &str,
    after: &str,
    proposal: &ProposalRecord,
    edited_at_accept: bool,
    accepted_at: &str,
) -> Result<usize, String> {
    let source = margent_core::authorship::AuthorshipSourceRecord {
        proposal_id: proposal.id.clone(),
        adapter_id: proposal.adapter_id.clone(),
        agent_id: match proposal.adapter_id.as_str() {
            "codex" | "claude" => Some(proposal.adapter_id.clone()),
            _ => None,
        },
        author_name: match proposal.adapter_id.as_str() {
            "codex" => "Codex".into(),
            "claude" => "Claude Code".into(),
            other => other.to_string(),
        },
        accepted_at: accepted_at.to_string(),
        edited_at_accept,
    };

    let mut span_count = 0usize;
    let mut record = margent_core::authorship::build_authorship_record(
        &document.id,
        &document.relative_path,
        before,
        after,
        accepted_at,
        source,
        || {
            span_count += 1;
            next_id("span").unwrap_or_else(|_| format!("span_fallback_{span_count}"))
        },
    );

    let new_span_count = record.spans.len();
    if new_span_count == 0 {
        return Ok(0);
    }

    let mdreview_path = file_service::ensure_workspace_layout(workspace_root)?;
    let authorship_path = mdreview_path
        .join("authorship")
        .join(format!("{}.json", document.id));
    if let Some(existing) = file_service::read_optional_json::<
        margent_core::authorship::AuthorshipMapRecord,
    >(&authorship_path)?
    {
        let mut spans = existing.spans;
        spans.extend(record.spans);
        record.spans = spans;
    }

    file_service::write_json_atomic(&authorship_path, &record)?;
    Ok(new_span_count)
}

fn resolve_threads_for_acceptance(
    workspace_root: &str,
    thread_ids: &[String],
) -> Result<(), String> {
    for thread_id in thread_ids {
        match thread_service::load_thread(workspace_root, thread_id) {
            Ok(thread) if thread.status == "resolved" => {}
            Ok(_) => {
                thread_service::resolve_thread(workspace_root, thread_id)?;
            }
            Err(error) if error.contains("not found") => {}
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

fn proposal_path(workspace_root: &Path, proposal_id: &str) -> Result<PathBuf, String> {
    let mdreview_path = file_service::ensure_workspace_layout(workspace_root)?;
    Ok(mdreview_path
        .join("proposals")
        .join(format!("{proposal_id}.json")))
}

fn append_proposal_event(
    workspace_root: &Path,
    event_type: &str,
    proposal_id: &str,
    thread_id: &str,
    document_id: &str,
    _adapter_id: Option<&str>,
) -> Result<(), String> {
    thread_service::append_event(
        workspace_root,
        event_type,
        Some(thread_id),
        Some(document_id),
        Some(proposal_id),
        None,
    )?;
    Ok(())
}

fn append_proposal_event_for_record(
    workspace_root: &Path,
    event_type: &str,
    proposal: &ProposalRecord,
) -> Result<(), String> {
    append_proposal_event(
        workspace_root,
        event_type,
        &proposal.id,
        proposal
            .thread_ids
            .first()
            .map(String::as_str)
            .unwrap_or(""),
        &proposal.document_id,
        Some(proposal.adapter_id.as_str()),
    )
}

fn refresh_pending_proposals_for_document(
    workspace_root: &Path,
    document_id: &str,
    exclude_proposal_id: Option<&str>,
) -> Result<(), String> {
    let start = Instant::now();
    let current_content_hash = current_document_hash(workspace_root, document_id)?;
    let mdreview_path = file_service::ensure_workspace_layout(workspace_root)?;
    let proposals_dir = mdreview_path.join("proposals");
    let mut scanned_count = 0usize;
    let mut document_proposal_count = 0usize;
    let mut stale_count = 0usize;

    for entry in fs::read_dir(&proposals_dir)
        .map_err(|error| format!("Unable to read {}: {error}", proposals_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to inspect proposal records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }
        scanned_count += 1;

        let Some(mut proposal) = read_scanned_sidecar::<ProposalRecord>(&path, "proposal")? else {
            continue;
        };

        if proposal.document_id != document_id {
            continue;
        }
        document_proposal_count += 1;

        if exclude_proposal_id == Some(proposal.id.as_str()) {
            continue;
        }

        if proposal.status == "pending" && proposal.base_content_hash != current_content_hash {
            mark_proposal_stale(workspace_root, &mut proposal)?;
            stale_count += 1;
        }
    }

    #[cfg(debug_assertions)]
    eprintln!(
        "[margent timing] refresh_pending_proposals_for_document: scanned={}, document_proposals={}, staled={}, elapsed={:.1}ms",
        scanned_count,
        document_proposal_count,
        stale_count,
        start.elapsed().as_secs_f64() * 1000.0
    );
    #[cfg(not(debug_assertions))]
    let _ = (start, scanned_count, document_proposal_count, stale_count);

    Ok(())
}

fn current_document_hash(workspace_root: &Path, document_id: &str) -> Result<String, String> {
    let (_, _, content) = load_document_context(workspace_root, document_id)?;
    Ok(file_service::content_hash(&content))
}

fn mark_proposal_stale(workspace_root: &Path, proposal: &mut ProposalRecord) -> Result<(), String> {
    let mut changed = false;

    if proposal.status != "stale" {
        proposal.status = "stale".into();
        proposal.updated_at = file_service::now_rfc3339()?;
        changed = true;
    }

    if !proposal
        .warnings
        .iter()
        .any(|warning| warning == STALE_PROPOSAL_WARNING)
    {
        proposal.warnings.push(STALE_PROPOSAL_WARNING.into());
        changed = true;
    }

    if changed {
        save_proposal_record(workspace_root, proposal)?;
        append_proposal_event_for_record(workspace_root, "proposal.stale", proposal)?;
    }

    Ok(())
}

fn load_document_context(
    workspace_root: &Path,
    document_id: &str,
) -> Result<(DocumentRecord, PathBuf, String), String> {
    if let Some(record) =
        workspace_service::hydrate_document_record_by_id(workspace_root, document_id)?
    {
        let document_path =
            file_service::resolve_document_path(workspace_root, &record.relative_path)?;
        let content = fs::read_to_string(&document_path)
            .map_err(|error| format!("Unable to read {}: {error}", document_path.display()))?;

        return Ok((record, document_path, content));
    }

    Err(format!("Document {document_id} was not found."))
}

fn summarize_proposal(assistant_message: &str, adapter_name: &str) -> String {
    let normalized = assistant_message.replace('\n', " ").trim().to_string();

    if normalized.is_empty() {
        return format!("Proposal from {adapter_name}");
    }

    if normalized.len() > 96 {
        format!("{}...", &normalized[..93])
    } else {
        normalized
    }
}

fn some_stderr(stderr: String) -> Option<String> {
    if stderr.trim().is_empty() {
        None
    } else {
        Some(stderr)
    }
}

fn next_id(prefix: &str) -> Result<String, String> {
    Ok(margent_core::id::new_id(prefix))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::thread::sleep;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use crate::models::thread::AnchorRecord;

    use super::*;
    use crate::services::{file_service, thread_service, workspace_service};

    #[test]
    fn request_proposal_persists_a_pending_record_from_a_generic_adapter() {
        let workspace_root = unique_temp_dir("margent-proposal-test");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, "Hello world\nSecond line\n").expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let adapter_path = workspace_root.join("mock-adapter.sh");

        fs::write(
            &adapter_path,
            r#"#!/bin/sh
cat >/dev/null
printf '%s' '{"status":"ok","responseMode":"updated_document","assistantMessage":"Updated the selected sentence.","updatedDocumentText":"Hello universe\nSecond line\n","resolveThreadIds":[],"warnings":[]}'
"#,
        )
        .expect("write adapter");

        let mut permissions = fs::metadata(&adapter_path)
            .expect("adapter metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&adapter_path, permissions).expect("chmod adapter");

        let adapters_path = workspace_root.join(".mdreview").join("adapters.json");
        fs::write(
            &adapters_path,
            format!(
                r#"[{{
  "id": "generic-test",
  "name": "Generic Test",
  "command": "{}",
  "args": [],
  "workingDirectoryMode": "workspace_root",
  "environmentAllowlist": [],
  "inputMode": "stdin_json",
  "outputMode": "stdout_json",
  "capabilities": ["propose_revision"],
  "timeoutSeconds": 5
}}]
"#,
                adapter_path.to_string_lossy()
            ),
        )
        .expect("write adapters");

        let thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &document.id,
            "world",
            "Make this less generic.",
            AnchorRecord {
                quote: "world".into(),
                prefix_context: "Hello ".into(),
                suffix_context: "\nSecond".into(),
                start_offset_utf16: 6,
                end_offset_utf16: 11,
                start_line: 1,
                start_column: 7,
                end_line: 1,
                end_column: 12,
                heading_path: Vec::new(),
                block_fingerprint: "sha256:test".into(),
                base_content_hash: file_service::content_hash("Hello world\nSecond line\n"),
                kind: "text_span".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
        )
        .expect("create thread");

        let proposal = request_proposal(
            workspace_root.to_str().expect("root str"),
            &document.id,
            &thread.id,
            "generic-test",
            "Revise only the first sentence.",
        )
        .expect("request proposal");

        assert_eq!(proposal.status, "pending");
        assert_eq!(proposal.adapter_id, "generic-test");
        assert!(proposal.computed_diff.contains("Hello universe"));
        assert_eq!(
            proposal.updated_document_text.as_deref(),
            Some("Hello universe\nSecond line\n")
        );

        let persisted_proposals =
            load_proposals(workspace_root.to_str().expect("root str"), &document.id)
                .expect("load proposals");
        assert_eq!(persisted_proposals.len(), 1);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn accept_proposal_applies_document_and_stales_older_pending_proposals() {
        let workspace_root = unique_temp_dir("margent-accept-test");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, "Hello world\nSecond line\n").expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let adapter_path = workspace_root.join("mock-adapter.sh");

        fs::write(
            &adapter_path,
            r#"#!/bin/sh
cat >/dev/null
printf '%s' '{"status":"ok","responseMode":"updated_document","assistantMessage":"Updated the selected sentence.","updatedDocumentText":"Hello brave world\nSecond line\n","resolveThreadIds":[],"warnings":[]}'
"#,
        )
        .expect("write adapter");

        let mut permissions = fs::metadata(&adapter_path)
            .expect("adapter metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&adapter_path, permissions).expect("chmod adapter");

        let adapters_path = workspace_root.join(".mdreview").join("adapters.json");
        fs::write(
            &adapters_path,
            format!(
                r#"[{{
  "id": "generic-test",
  "name": "Generic Test",
  "command": "{}",
  "args": [],
  "workingDirectoryMode": "workspace_root",
  "environmentAllowlist": [],
  "inputMode": "stdin_json",
  "outputMode": "stdout_json",
  "capabilities": ["propose_revision"],
  "timeoutSeconds": 5
}}]
"#,
                adapter_path.to_string_lossy()
            ),
        )
        .expect("write adapters");

        let thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &document.id,
            "world",
            "Make this less generic.",
            AnchorRecord {
                quote: "world".into(),
                prefix_context: "Hello ".into(),
                suffix_context: "\nSecond".into(),
                start_offset_utf16: 6,
                end_offset_utf16: 11,
                start_line: 1,
                start_column: 7,
                end_line: 1,
                end_column: 12,
                heading_path: Vec::new(),
                block_fingerprint: "sha256:test".into(),
                base_content_hash: file_service::content_hash("Hello world\nSecond line\n"),
                kind: "text_span".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
        )
        .expect("create thread");

        let first_proposal = request_proposal(
            workspace_root.to_str().expect("root str"),
            &document.id,
            &thread.id,
            "generic-test",
            "Revise only the first sentence.",
        )
        .expect("request first proposal");
        sleep(Duration::from_millis(1));
        let second_proposal = request_proposal(
            workspace_root.to_str().expect("root str"),
            &document.id,
            &thread.id,
            "generic-test",
            "Use the same idea again.",
        )
        .expect("request second proposal");

        let accepted = accept_proposal(
            workspace_root.to_str().expect("root str"),
            &first_proposal.id,
            None,
        )
        .expect("accept proposal");

        assert_eq!(accepted.proposal.status, "accepted");
        assert_eq!(
            accepted
                .document
                .as_ref()
                .map(|document| document.content.as_str()),
            Some("Hello brave world\nSecond line\n")
        );
        assert_eq!(
            fs::read_to_string(&document_path).expect("read accepted document"),
            "Hello brave world\nSecond line\n"
        );

        let persisted_proposals =
            load_proposals(workspace_root.to_str().expect("root str"), &document.id)
                .expect("load proposals");
        let accepted_record = persisted_proposals
            .iter()
            .find(|proposal| proposal.id == first_proposal.id)
            .expect("accepted proposal persisted");
        let stale_record = persisted_proposals
            .iter()
            .find(|proposal| proposal.id == second_proposal.id)
            .expect("stale proposal persisted");

        assert_eq!(accepted_record.status, "accepted");
        assert_eq!(stale_record.status, "stale");

        let mdreview_path =
            file_service::ensure_workspace_layout(&workspace_root).expect("workspace layout");
        let authorship_path = mdreview_path
            .join("authorship")
            .join(format!("{}.json", document.id));
        let authorship = file_service::read_optional_json::<
            margent_core::authorship::AuthorshipMapRecord,
        >(&authorship_path)
        .expect("read authorship")
        .expect("authorship record");
        assert_eq!(
            authorship.content_hash,
            file_service::content_hash("Hello brave world\nSecond line\n")
        );
        assert_eq!(authorship.spans.len(), 1);
        assert_eq!(authorship.spans[0].quote, "brave ");
        assert_eq!(authorship.spans[0].source.proposal_id, first_proposal.id);
        assert_eq!(authorship.spans[0].source.adapter_id, "generic-test");

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn accept_proposal_marks_hash_mismatch_stale_without_error() {
        let workspace_root = unique_temp_dir("margent-tauri-stale-proposal");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, "Original text.\n").expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let proposal = proposal_record(
            "proposal_stale",
            document,
            "Accepted text.\n",
            Vec::new(),
            Vec::new(),
        );
        save_proposal_record(&workspace_root, &proposal).expect("save proposal");
        workspace_service::save_document(
            workspace_root.to_str().expect("root str"),
            "draft.md",
            "Human edit first.\n",
        )
        .expect("change document");

        let result = accept_proposal(
            workspace_root.to_str().expect("root str"),
            &proposal.id,
            None,
        )
        .expect("hash mismatch returns stale result");

        assert_eq!(result.proposal.status, "stale");
        assert!(result.document.is_none());
        assert!(result.snapshot.is_none());
        assert!(result
            .message
            .as_deref()
            .is_some_and(|message| message.contains("marked stale")));
        assert_eq!(
            fs::read_to_string(&document_path).expect("read unchanged document"),
            "Human edit first.\n"
        );
        let stale = load_proposal_record(&workspace_root, &proposal.id).expect("load stale");
        assert_eq!(stale.status, "stale");
        assert!(stale
            .warnings
            .iter()
            .any(|warning| warning.contains("older saved document hash")));

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn accept_proposal_snapshots_previous_document_and_resolves_threads() {
        let workspace_root = unique_temp_dir("margent-tauri-snapshot-resolve-thread");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let before = "Hello world\nSecond line\n";
        let updated = "Hello brave world\nSecond line\n";
        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, before).expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &document.id,
            "World",
            "Make this less generic.",
            text_anchor("world", before),
        )
        .expect("create thread");
        let proposal = proposal_record(
            "proposal_deferred_resolve",
            document,
            updated,
            vec![thread.id.clone()],
            vec![thread.id.clone(), "thread_missing".into()],
        );
        save_proposal_record(&workspace_root, &proposal).expect("save proposal");

        let result = accept_proposal(
            workspace_root.to_str().expect("root str"),
            &proposal.id,
            None,
        )
        .expect("accept proposal");

        assert_eq!(result.proposal.status, "accepted");
        assert_eq!(
            result.proposal.resolve_thread_ids,
            vec![thread.id.clone(), "thread_missing".into()]
        );
        let snapshot = result.snapshot.as_ref().expect("accept returns snapshot");
        assert_eq!(snapshot.document_id, document.id);
        assert_eq!(snapshot.relative_path, "draft.md");
        assert_eq!(snapshot.reason, "proposal.accept");
        assert_eq!(
            result
                .document
                .as_ref()
                .map(|document| document.content.as_str()),
            Some(updated)
        );
        assert_eq!(
            fs::read_to_string(&document_path).expect("read accepted document"),
            updated
        );
        let deferred_thread =
            thread_service::load_thread(workspace_root.to_str().expect("root str"), &thread.id)
                .expect("load thread");
        assert_eq!(deferred_thread.status, "resolved");
        let snapshots_dir = workspace_root.join(".mdreview").join("snapshots");
        let snapshot_paths = fs::read_dir(&snapshots_dir)
            .expect("read snapshots")
            .map(|entry| entry.expect("snapshot entry").path())
            .collect::<Vec<_>>();
        assert_eq!(snapshot_paths.len(), 1);
        let persisted_snapshot = file_service::read_optional_json::<
            crate::models::snapshot::DocumentSnapshotRecord,
        >(&snapshot_paths[0])
        .expect("read persisted snapshot")
        .expect("persisted snapshot");
        assert_eq!(persisted_snapshot.document_id, document.id);
        assert_eq!(persisted_snapshot.relative_path, "draft.md");
        assert_eq!(
            persisted_snapshot.content_hash,
            file_service::content_hash(before)
        );
        assert_eq!(persisted_snapshot.content, before);
        assert_eq!(persisted_snapshot.reason, "proposal.accept");
        assert_eq!(
            persisted_snapshot.proposal_id.as_deref(),
            Some(proposal.id.as_str())
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn proposal_change_set_ready_returns_stable_hunks_and_document_version() {
        let workspace_root = unique_temp_dir("margent-tauri-change-set-ready");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let before = "A\nB\nC\nD\nE\n";
        let after = "A\nBee\nC\nD\nEee\n";
        fs::write(workspace_root.join("draft.md"), before).expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let proposal = proposal_record(
            "proposal_change_set",
            document,
            after,
            Vec::new(),
            Vec::new(),
        );
        save_proposal_record(&workspace_root, &proposal).expect("save proposal");

        let result =
            get_proposal_change_set(workspace_root.to_str().expect("root str"), &proposal.id)
                .expect("get change set");

        let ProposalChangeSetResult::Ready {
            change_set,
            document_version,
            proposal: result_proposal,
        } = result
        else {
            panic!("expected ready change set");
        };

        assert_eq!(result_proposal.id, proposal.id);
        assert_eq!(
            document_version.content_hash,
            file_service::content_hash(before)
        );
        assert_eq!(change_set.document_id, document.id);
        assert_eq!(
            change_set.base_hash.as_deref(),
            Some(document.current_content_hash.as_str())
        );
        assert_eq!(change_set.hunks.len(), 2);
        assert_eq!(change_set.hunks[0].before_text, "B\n");
        assert_eq!(change_set.hunks[0].after_text, "Bee\n");
        assert_eq!(change_set.hunks[1].before_text, "E\n");
        assert_eq!(change_set.hunks[1].after_text, "Eee\n");

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn accept_proposal_hunks_applies_selected_subset() {
        let workspace_root = unique_temp_dir("margent-tauri-accept-selected-hunks");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let before = "A\nB\nC\nD\nE\n";
        let after = "A\nBee\nC\nD\nEee\n";
        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, before).expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let proposal = proposal_record(
            "proposal_selected_hunks",
            document,
            after,
            Vec::new(),
            Vec::new(),
        );
        save_proposal_record(&workspace_root, &proposal).expect("save proposal");
        let ProposalChangeSetResult::Ready {
            change_set,
            document_version,
            ..
        } = get_proposal_change_set(workspace_root.to_str().expect("root str"), &proposal.id)
            .expect("get change set")
        else {
            panic!("expected ready change set");
        };
        let selected_hunk_ids = vec![change_set.hunks[0].id.clone()];

        let result = accept_proposal_hunks(
            workspace_root.to_str().expect("root str"),
            &proposal.id,
            selected_hunk_ids.clone(),
            &document_version,
        )
        .expect("accept selected hunks");

        let ProposalHunkAcceptResult::Applied {
            result,
            applied_hunk_ids,
        } = result
        else {
            panic!("expected applied result");
        };

        assert_eq!(applied_hunk_ids, selected_hunk_ids);
        assert_eq!(result.proposal.status, "accepted");
        assert!(result.snapshot.is_some());
        assert_eq!(
            fs::read_dir(workspace_root.join(".mdreview").join("snapshots"))
                .expect("read snapshots")
                .count(),
            1
        );
        assert_eq!(
            fs::read_to_string(&document_path).expect("read accepted document"),
            "A\nBee\nC\nD\nE\n"
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn accept_proposal_hunks_handles_large_documents_without_char_diff_blowup() {
        let workspace_root = unique_temp_dir("margent-tauri-accept-large-hunks");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let prefix = "Stable setup paragraph that should remain unchanged.\n".repeat(350);
        let suffix = "Stable closing paragraph that should remain unchanged.\n".repeat(350);
        let before = format!("{prefix}Original paragraph.\n{suffix}");
        let after = format!("{prefix}Revised paragraph.\n{suffix}");
        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, &before).expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let proposal = proposal_record(
            "proposal_large_selected_hunks",
            document,
            &after,
            Vec::new(),
            Vec::new(),
        );
        save_proposal_record(&workspace_root, &proposal).expect("save proposal");
        let ProposalChangeSetResult::Ready {
            change_set,
            document_version,
            ..
        } = get_proposal_change_set(workspace_root.to_str().expect("root str"), &proposal.id)
            .expect("get change set")
        else {
            panic!("expected ready change set");
        };

        let result = accept_proposal_hunks(
            workspace_root.to_str().expect("root str"),
            &proposal.id,
            vec![change_set.hunks[0].id.clone()],
            &document_version,
        )
        .expect("accept selected hunks");

        let ProposalHunkAcceptResult::Applied { result, .. } = result else {
            panic!("expected applied result");
        };

        assert_eq!(result.proposal.status, "accepted");
        assert_eq!(
            fs::read_to_string(&document_path).expect("read accepted document"),
            after
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn accept_proposal_hunks_reports_expected_version_conflict() {
        let workspace_root = unique_temp_dir("margent-tauri-hunk-conflict");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let before = "A\nB\nC\n";
        let after = "A\nBee\nC\n";
        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, before).expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let proposal =
            proposal_record("proposal_conflict", document, after, Vec::new(), Vec::new());
        save_proposal_record(&workspace_root, &proposal).expect("save proposal");
        let ProposalChangeSetResult::Ready {
            change_set,
            document_version,
            ..
        } = get_proposal_change_set(workspace_root.to_str().expect("root str"), &proposal.id)
            .expect("get change set")
        else {
            panic!("expected ready change set");
        };
        fs::write(&document_path, "External edit\n").expect("external edit");

        let result = accept_proposal_hunks(
            workspace_root.to_str().expect("root str"),
            &proposal.id,
            vec![change_set.hunks[0].id.clone()],
            &document_version,
        )
        .expect("accept selected hunks");

        let ProposalHunkAcceptResult::Conflict { actual_version, .. } = result else {
            panic!("expected conflict result");
        };
        assert_eq!(
            actual_version.content_hash,
            file_service::content_hash("External edit\n")
        );
        assert_eq!(
            fs::read_to_string(&document_path).expect("read conflicted document"),
            "External edit\n"
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn accept_proposal_hunks_marks_stale_when_base_hash_changed() {
        let workspace_root = unique_temp_dir("margent-tauri-hunk-stale");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let before = "A\nB\nC\n";
        let after = "A\nBee\nC\n";
        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, before).expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let proposal = proposal_record(
            "proposal_stale_hunks",
            document,
            after,
            Vec::new(),
            Vec::new(),
        );
        save_proposal_record(&workspace_root, &proposal).expect("save proposal");
        let ProposalChangeSetResult::Ready { change_set, .. } =
            get_proposal_change_set(workspace_root.to_str().expect("root str"), &proposal.id)
                .expect("get change set")
        else {
            panic!("expected ready change set");
        };
        fs::write(&document_path, "A\nHuman edit\nC\n").expect("human edit");
        let current = workspace_service::read_document(
            workspace_root.to_str().expect("root str"),
            "draft.md",
        )
        .expect("read changed document");

        let result = accept_proposal_hunks(
            workspace_root.to_str().expect("root str"),
            &proposal.id,
            vec![change_set.hunks[0].id.clone()],
            &current.version,
        )
        .expect("accept selected hunks");

        let ProposalHunkAcceptResult::Stale { proposal, .. } = result else {
            panic!("expected stale result");
        };
        assert_eq!(proposal.status, "stale");
        assert_eq!(
            fs::read_to_string(&document_path).expect("read stale document"),
            "A\nHuman edit\nC\n"
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn reject_proposal_marks_it_rejected() {
        let workspace_root = unique_temp_dir("margent-reject-test");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, "Hello world\nSecond line\n").expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let adapter_path = workspace_root.join("mock-adapter.sh");

        fs::write(
            &adapter_path,
            r#"#!/bin/sh
cat >/dev/null
printf '%s' '{"status":"ok","responseMode":"updated_document","assistantMessage":"Updated the selected sentence.","updatedDocumentText":"Hello universe\nSecond line\n","resolveThreadIds":[],"warnings":[]}'
"#,
        )
        .expect("write adapter");

        let mut permissions = fs::metadata(&adapter_path)
            .expect("adapter metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&adapter_path, permissions).expect("chmod adapter");

        let adapters_path = workspace_root.join(".mdreview").join("adapters.json");
        fs::write(
            &adapters_path,
            format!(
                r#"[{{
  "id": "generic-test",
  "name": "Generic Test",
  "command": "{}",
  "args": [],
  "workingDirectoryMode": "workspace_root",
  "environmentAllowlist": [],
  "inputMode": "stdin_json",
  "outputMode": "stdout_json",
  "capabilities": ["propose_revision"],
  "timeoutSeconds": 5
}}]
"#,
                adapter_path.to_string_lossy()
            ),
        )
        .expect("write adapters");

        let thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &document.id,
            "world",
            "Make this less generic.",
            AnchorRecord {
                quote: "world".into(),
                prefix_context: "Hello ".into(),
                suffix_context: "\nSecond".into(),
                start_offset_utf16: 6,
                end_offset_utf16: 11,
                start_line: 1,
                start_column: 7,
                end_line: 1,
                end_column: 12,
                heading_path: Vec::new(),
                block_fingerprint: "sha256:test".into(),
                base_content_hash: file_service::content_hash("Hello world\nSecond line\n"),
                kind: "text_span".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
        )
        .expect("create thread");

        let proposal = request_proposal(
            workspace_root.to_str().expect("root str"),
            &document.id,
            &thread.id,
            "generic-test",
            "Revise only the first sentence.",
        )
        .expect("request proposal");

        let rejected = reject_proposal(workspace_root.to_str().expect("root str"), &proposal.id)
            .expect("reject proposal");

        assert_eq!(rejected.proposal.status, "rejected");

        let persisted_proposals =
            load_proposals(workspace_root.to_str().expect("root str"), &document.id)
                .expect("load proposals");
        assert_eq!(persisted_proposals.len(), 1);
        assert_eq!(persisted_proposals[0].status, "rejected");

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn load_proposals_skips_corrupt_sibling_sidecar() {
        let workspace_root = unique_temp_dir("margent-proposal-corrupt-sibling");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, "Original text.\n").expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace.documents.first().expect("document indexed");
        let valid_proposal = proposal_record(
            "proposal_valid",
            document,
            "Revised text.\n",
            Vec::new(),
            Vec::new(),
        );
        save_proposal_record(&workspace_root, &valid_proposal).expect("save valid proposal");

        let mdreview_path =
            file_service::ensure_workspace_layout(&workspace_root).expect("workspace layout");
        fs::write(
            mdreview_path
                .join("proposals")
                .join("proposal_corrupt.json"),
            "{ not valid json",
        )
        .expect("write corrupt proposal");

        let proposals = load_proposals(workspace_root.to_str().expect("root str"), &document.id)
            .expect("load proposals");

        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].id, valid_proposal.id);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nonce}"))
    }

    fn text_anchor(quote: &str, content: &str) -> AnchorRecord {
        let start = content.find(quote).expect("quote exists");
        AnchorRecord {
            quote: quote.into(),
            prefix_context: content[..start].into(),
            suffix_context: content[start + quote.len()..].into(),
            start_offset_utf16: start,
            end_offset_utf16: start + quote.len(),
            start_line: 1,
            start_column: start + 1,
            end_line: 1,
            end_column: start + quote.len() + 1,
            heading_path: Vec::new(),
            block_fingerprint: file_service::content_hash(quote),
            base_content_hash: file_service::content_hash(content),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        }
    }

    fn proposal_record(
        id: &str,
        document: &DocumentRecord,
        updated_document_text: &str,
        thread_ids: Vec<String>,
        resolve_thread_ids: Vec<String>,
    ) -> ProposalRecord {
        ProposalRecord {
            schema_version: 1,
            id: id.into(),
            document_id: document.id.clone(),
            thread_ids,
            adapter_id: "test-adapter".into(),
            created_at: "2026-06-11T00:00:00Z".into(),
            updated_at: "2026-06-11T00:00:00Z".into(),
            status: "pending".into(),
            base_content_hash: document.current_content_hash.clone(),
            response_mode: "updated_document".into(),
            summary: "Test proposal".into(),
            assistant_message: "Test assistant message".into(),
            updated_document_text: Some(updated_document_text.into()),
            unified_diff: None,
            computed_diff: String::new(),
            warnings: Vec::new(),
            resolve_thread_ids,
            stderr: None,
            error_message: None,
            extra: Default::default(),
        }
    }
}
