use std::{fs, path::Path};

use serde::Serialize;
use similar::TextDiff;

use crate::models::*;
use crate::provider::{self, AgentAction, AgentActionEnvelope, Provider, RevisionResult};
use crate::workspace;

const CODIFY_AGENT_ID: &str = "codify";
const CODIFY_PROMPT_TRUNCATE: usize = 2_400;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodifyResult {
    pub provider: String,
    pub dry_run: bool,
    pub processed_events: usize,
    pub relevant_events: usize,
    pub memory_path: String,
    pub changed: bool,
    pub last_seen_event_id: Option<String>,
    pub memory: Option<String>,
}

// ── Write a feedback reply to a thread ──────────────────────────────────────

pub fn write_feedback_reply(
    root: &Path,
    thread: &mut ThreadRecord,
    provider: Provider,
    feedback_text: &str,
) -> Result<(), String> {
    let updated = workspace::add_thread_message(
        root,
        &thread.id,
        feedback_text,
        "reply",
        "agent",
        provider.display_name(),
        Some(provider.id()),
        None,
    )?;
    *thread = updated;
    Ok(())
}

// ── Codify review memory ────────────────────────────────────────────────────

pub fn run_codify(root: &Path, provider: Provider, dry_run: bool) -> Result<CodifyResult, String> {
    let mut cursor =
        workspace::load_agent_cursor(root, CODIFY_AGENT_ID)?.unwrap_or(AgentCursorRecord {
            agent_id: CODIFY_AGENT_ID.to_string(),
            provider_id: Some(provider.id().to_string()),
            adapter_id: None,
            last_seen_event_id: None,
            last_synced_at: None,
            last_sync_status: None,
            notes: Some("Tracks events distilled into .mdreview/memory.md.".into()),
        });

    cursor.provider_id = Some(provider.id().to_string());

    let events = workspace::load_events(root)?;
    let start_idx = if let Some(last_id) = cursor.last_seen_event_id.as_deref() {
        events
            .iter()
            .position(|event| event.id == last_id)
            .map(|index| index + 1)
            .unwrap_or(0)
    } else {
        0
    };
    let new_events = &events[start_idx..];
    let last_seen_event_id = new_events.last().map(|event| event.id.clone());
    let outcomes = collect_codify_outcomes(root, new_events);
    let memory_path = margent_core::review_context::MEMORY_RELATIVE_PATH.to_string();

    if outcomes.is_empty() {
        if !dry_run {
            cursor.last_seen_event_id = last_seen_event_id.clone();
            cursor.last_synced_at = Some(workspace::now_rfc3339()?);
            cursor.last_sync_status = Some("ok".into());
            workspace::save_agent_cursor(root, &cursor)?;
        }
        return Ok(CodifyResult {
            provider: provider.id().into(),
            dry_run,
            processed_events: new_events.len(),
            relevant_events: 0,
            memory_path,
            changed: false,
            last_seen_event_id,
            memory: None,
        });
    }

    let existing_memory = read_existing_memory(root)?;
    let prompt = provider::build_codify_prompt(existing_memory.as_deref(), &outcomes);
    let response = provider::execute_provider_with_options(provider, &prompt, Default::default())?;
    if !response.success {
        cursor.last_synced_at = Some(workspace::now_rfc3339()?);
        cursor.last_sync_status = Some("error".into());
        if !dry_run {
            workspace::save_agent_cursor(root, &cursor)?;
        }
        let mut err = format!("{} returned a non-zero exit code.", provider.display_name());
        if !response.stderr.is_empty() {
            err.push_str(&format!("\nstderr: {}", response.stderr.trim()));
        }
        return Err(err);
    }

    let raw_memory = provider::parse_feedback_response(provider, &response)?;
    let memory = normalize_codify_memory(&raw_memory)?;
    let changed = existing_memory.as_deref().map(str::trim) != Some(memory.trim());

    if !dry_run {
        let path = root.join(margent_core::review_context::MEMORY_RELATIVE_PATH);
        workspace::write_string_atomic(&path, &memory)?;
        cursor.last_seen_event_id = last_seen_event_id.clone();
        cursor.last_synced_at = Some(workspace::now_rfc3339()?);
        cursor.last_sync_status = Some("ok".into());
        workspace::save_agent_cursor(root, &cursor)?;
    }

    Ok(CodifyResult {
        provider: provider.id().into(),
        dry_run,
        processed_events: new_events.len(),
        relevant_events: outcomes.len(),
        memory_path,
        changed,
        last_seen_event_id,
        memory: Some(memory),
    })
}

fn collect_codify_outcomes(root: &Path, events: &[EventRecord]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event.event_type.as_str() {
            "thread.resolved" => event
                .thread_id
                .as_deref()
                .map(|thread_id| codify_thread_outcome(root, event, thread_id)),
            "proposal.accepted" | "proposal.rejected" | "proposal.stale" => event
                .proposal_id
                .as_deref()
                .map(|proposal_id| codify_proposal_outcome(root, event, proposal_id)),
            _ => None,
        })
        .collect()
}

fn codify_thread_outcome(root: &Path, event: &EventRecord, thread_id: &str) -> String {
    match workspace::load_thread(root, thread_id) {
        Ok(thread) => {
            let document_label = workspace::load_document_by_id(root, &thread.document_id)
                .map(|document| document.relative_path)
                .unwrap_or_else(|_| thread.document_id.clone());
            let mut summary = String::new();
            summary.push_str(&format!(
                "- Event: {} at {}\n- Document: {}\n- Thread: {} ({})\n- Anchor: {}\n- Tags: {}\n",
                event.event_type,
                event.timestamp,
                document_label,
                thread.title,
                thread.id,
                truncate_for_codify(&thread.anchor.quote),
                if thread.tags.is_empty() {
                    "none".into()
                } else {
                    thread.tags.join(", ")
                }
            ));
            summary.push_str("- Conversation outcome:\n");
            let start = thread.messages.len().saturating_sub(6);
            for message in &thread.messages[start..] {
                summary.push_str(&format!(
                    "  - {}: {}\n",
                    message.author_name,
                    truncate_for_codify(&message.body)
                ));
            }
            summary
        }
        Err(error) => format!(
            "- Event: {} at {}\n- Thread: {thread_id}\n- Warning: unable to load thread sidecar: {error}\n",
            event.event_type, event.timestamp
        ),
    }
}

fn codify_proposal_outcome(root: &Path, event: &EventRecord, proposal_id: &str) -> String {
    match workspace::load_proposal(root, proposal_id) {
        Ok(proposal) => {
            let document_label = workspace::load_document_by_id(root, &proposal.document_id)
                .map(|document| document.relative_path)
                .unwrap_or_else(|_| proposal.document_id.clone());
            let thread_titles = proposal
                .thread_ids
                .iter()
                .filter_map(|thread_id| workspace::load_thread(root, thread_id).ok())
                .map(|thread| format!("{} ({})", thread.title, thread.id))
                .collect::<Vec<_>>();
            let mut summary = String::new();
            summary.push_str(&format!(
                "- Event: {} at {}\n- Document: {}\n- Proposal: {} [{}]\n- Provider/adapter: {}\n- Threads: {}\n- Summary: {}\n- Assistant message: {}\n",
                event.event_type,
                event.timestamp,
                document_label,
                proposal.id,
                proposal.status,
                proposal.adapter_id,
                if thread_titles.is_empty() {
                    proposal.thread_ids.join(", ")
                } else {
                    thread_titles.join("; ")
                },
                truncate_for_codify(&proposal.summary),
                truncate_for_codify(&proposal.assistant_message)
            ));
            if !proposal.warnings.is_empty() {
                summary.push_str(&format!("- Warnings: {}\n", proposal.warnings.join("; ")));
            }
            if !proposal.computed_diff.trim().is_empty() {
                summary.push_str("- Computed diff:\n```diff\n");
                summary.push_str(&truncate_for_codify(&proposal.computed_diff));
                summary.push_str("\n```\n");
            }
            summary
        }
        Err(error) => format!(
            "- Event: {} at {}\n- Proposal: {proposal_id}\n- Warning: unable to load proposal sidecar: {error}\n",
            event.event_type, event.timestamp
        ),
    }
}

fn read_existing_memory(root: &Path) -> Result<Option<String>, String> {
    let path = root.join(margent_core::review_context::MEMORY_RELATIVE_PATH);
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn normalize_codify_memory(raw: &str) -> Result<String, String> {
    let mut trimmed = raw.trim();
    if let Some(stripped) = trimmed.strip_prefix("```markdown") {
        trimmed = stripped.trim_start();
        if let Some(end) = trimmed.rfind("```") {
            trimmed = trimmed[..end].trim();
        }
    } else if let Some(stripped) = trimmed.strip_prefix("```") {
        trimmed = stripped.trim_start();
        if let Some(end) = trimmed.rfind("```") {
            trimmed = trimmed[..end].trim();
        }
    }

    if trimmed.is_empty() {
        return Err("Provider returned empty review memory.".into());
    }

    let mut memory = trimmed.to_string();
    memory.push('\n');
    Ok(memory)
}

fn truncate_for_codify(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= CODIFY_PROMPT_TRUNCATE {
        return normalized;
    }
    let truncated = normalized
        .chars()
        .take(CODIFY_PROMPT_TRUNCATE.saturating_sub(3))
        .collect::<String>();
    format!("{truncated}...")
}

// ── Write a revision proposal ───────────────────────────────────────────────

pub fn write_revision_proposal(
    root: &Path,
    thread: &mut ThreadRecord,
    provider: Provider,
    document: &DocumentRecord,
    document_content: &str,
    revision: &RevisionResult,
) -> Result<ProposalRecord, String> {
    let now = workspace::now_rfc3339()?;
    let proposal_id = workspace::next_id("proposal")?;
    let resolve_thread_ids = revision
        .resolve_thread_ids
        .iter()
        .filter(|id| id.as_str() == thread.id)
        .cloned()
        .collect::<Vec<_>>();

    let computed_diff = compute_unified_diff(document_content, &revision.updated_document_text);

    let proposal = ProposalRecord {
        schema_version: 1,
        id: proposal_id,
        document_id: document.id.clone(),
        thread_ids: vec![thread.id.clone()],
        adapter_id: provider.id().to_string(),
        created_at: now.clone(),
        updated_at: now.clone(),
        status: "pending".into(),
        base_content_hash: document.current_content_hash.clone(),
        response_mode: "updated_document".into(),
        summary: summarize(&revision.assistant_message, provider.display_name()),
        assistant_message: revision.assistant_message.clone(),
        updated_document_text: Some(revision.updated_document_text.clone()),
        unified_diff: None,
        computed_diff,
        warnings: Vec::new(),
        resolve_thread_ids,
        stderr: None,
        error_message: None,
    };

    workspace::save_proposal(root, &proposal)?;

    // Link proposal to thread
    if !thread.linked_proposal_ids.contains(&proposal.id) {
        thread.linked_proposal_ids.push(proposal.id.clone());
        thread.updated_at = now;
        workspace::save_thread(root, thread)?;
    }

    workspace::append_event(
        root,
        "proposal.received",
        Some(&thread.id),
        Some(&document.id),
        Some(&proposal.id),
        None,
    )?;

    Ok(proposal)
}

pub fn apply_revision_directly(
    root: &Path,
    thread: &mut ThreadRecord,
    provider: Provider,
    document: &DocumentRecord,
    document_content: &str,
    revision: &RevisionResult,
    resolve_thread_after_apply: bool,
) -> Result<(ProposalRecord, DocumentRecord, Option<ThreadRecord>), String> {
    let current_document_text = workspace::read_document_content(root, &document.relative_path)?;
    let current_content_hash = workspace::content_hash(&current_document_text);
    if current_content_hash != document.current_content_hash {
        return Err(
            "The document changed on disk while the provider was running. Re-run the command or save the revision as a proposal instead."
                .into(),
        );
    }

    workspace::snapshot_document(
        root,
        document,
        &current_document_text,
        "provider.direct_apply",
        None,
    )?;

    let mut proposal =
        write_revision_proposal(root, thread, provider, document, document_content, revision)?;
    let document_record = workspace::save_document(
        root,
        &document.relative_path,
        &revision.updated_document_text,
    )?;

    proposal.status = "accepted".into();
    proposal.updated_at = workspace::now_rfc3339()?;
    workspace::save_proposal(root, &proposal)?;
    workspace::record_authorship_for_acceptance(
        root,
        &document_record,
        &current_document_text,
        &revision.updated_document_text,
        &proposal,
        false,
        &proposal.updated_at,
    )?;
    workspace::append_event(
        root,
        "proposal.accepted",
        Some(&thread.id),
        Some(&document.id),
        Some(&proposal.id),
        None,
    )?;

    let should_resolve = resolve_thread_after_apply
        || proposal
            .resolve_thread_ids
            .iter()
            .any(|id| id == &thread.id);
    let resolved_thread = if should_resolve && thread.status != "resolved" {
        let resolved = workspace::resolve_thread(root, &thread.id)?;
        *thread = resolved.clone();
        Some(resolved)
    } else {
        None
    };

    Ok((proposal, document_record, resolved_thread))
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AppliedAgentActionSummary {
    pub replies: usize,
    pub proposals: usize,
    pub threads: usize,
    pub noops: usize,
}

impl AppliedAgentActionSummary {
    fn total(self) -> usize {
        self.replies + self.proposals + self.threads + self.noops
    }
}

pub fn apply_agent_action_envelope(
    root: &Path,
    provider: Provider,
    default_document: &DocumentRecord,
    default_document_content: &str,
    envelope: AgentActionEnvelope,
) -> Result<AppliedAgentActionSummary, String> {
    let mut summary = AppliedAgentActionSummary::default();

    for action in envelope.actions {
        match action {
            AgentAction::ReplyToThread {
                thread_id,
                reply_to_message_id,
                body,
            } => {
                workspace::add_thread_message(
                    root,
                    &thread_id,
                    &body,
                    "reply",
                    "agent",
                    provider.display_name(),
                    Some(provider.id()),
                    reply_to_message_id.as_deref(),
                )?;
                summary.replies += 1;
            }
            AgentAction::ProposeRevision {
                thread_id,
                assistant_message,
                response_mode,
                updated_document_text,
                unified_diff,
                resolve_thread_ids,
            } => {
                let mode = response_mode.as_deref().unwrap_or("updated_document");
                if mode != "updated_document" {
                    return Err(format!(
                        "propose_revision for thread {thread_id} used unsupported responseMode {mode:?}; only updated_document is supported."
                    ));
                }

                let Some(updated_document_text) = updated_document_text else {
                    let hint = if unified_diff.is_some() {
                        " unifiedDiff is not applied by sync yet."
                    } else {
                        ""
                    };
                    return Err(format!(
                        "propose_revision for thread {thread_id} is missing updatedDocumentText.{hint}"
                    ));
                };

                let mut thread = workspace::load_thread(root, &thread_id)?;
                let document = workspace::load_document_by_id(root, &thread.document_id)?;
                let document_content = if document.id == default_document.id {
                    default_document_content.to_string()
                } else {
                    workspace::read_document_content(root, &document.relative_path)?
                };
                let revision = RevisionResult {
                    assistant_message,
                    updated_document_text,
                    resolve_thread_ids,
                };
                write_revision_proposal(
                    root,
                    &mut thread,
                    provider,
                    &document,
                    &document_content,
                    &revision,
                )?;
                summary.proposals += 1;
            }
            AgentAction::AddThread {
                document_id,
                relative_path,
                quote,
                quote_occurrence,
                title,
                body,
                tags,
            } => {
                let document = resolve_action_document(
                    root,
                    default_document,
                    document_id.as_deref(),
                    relative_path.as_deref(),
                )?;
                let document_content = if document.id == default_document.id {
                    default_document_content.to_string()
                } else {
                    workspace::read_document_content(root, &document.relative_path)?
                };
                let anchor = workspace::build_anchor_from_quote(
                    &document,
                    &document_content,
                    &quote,
                    quote_occurrence,
                )?;
                let mut thread = workspace::create_thread(
                    root,
                    &document,
                    title.as_deref().unwrap_or(""),
                    &body,
                    anchor,
                    provider.id(),
                    "agent",
                    provider.display_name(),
                    Some(provider.id()),
                )?;
                if !tags.is_empty() {
                    thread.tags = tags;
                    workspace::save_thread(root, &thread)?;
                }
                summary.threads += 1;
            }
            AgentAction::Noop { reason } => {
                let _ = reason.as_deref();
                summary.noops += 1;
            }
        }
    }

    Ok(summary)
}

fn resolve_action_document(
    root: &Path,
    default_document: &DocumentRecord,
    document_id: Option<&str>,
    relative_path: Option<&str>,
) -> Result<DocumentRecord, String> {
    match (document_id, relative_path) {
        (Some(document_id), None) => workspace::load_document_by_id(root, document_id),
        (None, Some(relative_path)) => workspace::resolve_document(root, Some(relative_path)),
        (None, None) => Ok(default_document.clone()),
        (Some(_), Some(_)) => {
            Err("add_thread must include either documentId or relativePath, not both.".into())
        }
    }
}

// ── Sync cycle ──────────────────────────────────────────────────────────────

pub fn run_sync(root: &Path, provider: Provider, pass_name: Option<&str>) -> Result<(), String> {
    let agent_id = provider.id();
    let mut cursor = workspace::load_agent_cursor(root, agent_id)?.unwrap_or(AgentCursorRecord {
        agent_id: agent_id.to_string(),
        provider_id: None,
        adapter_id: None,
        last_seen_event_id: None,
        last_synced_at: None,
        last_sync_status: None,
        notes: None,
    });

    let events = workspace::load_events(root)?;

    // Find events after the last seen event
    let start_idx = if let Some(ref last_id) = cursor.last_seen_event_id {
        events
            .iter()
            .position(|e| e.id == *last_id)
            .map(|i| i + 1)
            .unwrap_or(0)
    } else {
        0
    };

    let new_events = &events[start_idx..];
    if new_events.is_empty() {
        eprintln!("No new events since last sync.");
        let now = workspace::now_rfc3339()?;
        cursor.last_synced_at = Some(now);
        cursor.last_sync_status = Some("ok".into());
        workspace::save_agent_cursor(root, &cursor)?;
        return Ok(());
    }

    eprintln!("Processing {} new event(s)...", new_events.len());

    let mut last_event_id = cursor.last_seen_event_id.clone();
    let mut processed = 0;
    let mut errors = 0;

    for event in new_events {
        last_event_id = Some(event.id.clone());

        // Only respond to thread-related events
        match event.event_type.as_str() {
            "thread.created" | "thread.message_added" => {
                let thread_id = match &event.thread_id {
                    Some(id) => id.clone(),
                    None => continue,
                };

                let mut thread = match workspace::load_thread(root, &thread_id) {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("  Skipping event {}: {e}", event.id);
                        continue;
                    }
                };

                // Don't respond to our own messages
                if let Some(last_msg) = thread.messages.last() {
                    if last_msg.agent_id.as_deref() == Some(agent_id) {
                        continue;
                    }
                }

                // Find the document
                let doc = match workspace::load_document_by_id(root, &thread.document_id) {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("  Skipping event {}: {e}", event.id);
                        continue;
                    }
                };

                let content = match workspace::read_document_content(root, &doc.relative_path) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("  Skipping event {}: {e}", event.id);
                        continue;
                    }
                };

                // Generate an action envelope for this review event.
                eprintln!("  Generating actions for thread \"{}\"...", thread.title);
                let prompt = provider::build_sync_action_prompt(
                    &content,
                    &doc.relative_path,
                    &thread,
                    agent_id,
                );
                let context = margent_core::review_context::load_review_context(root, pass_name)?;
                let prompt = margent_core::review_context::prepend_review_context(prompt, &context);

                match provider::execute_provider_for_thread(provider, &prompt, &thread) {
                    Ok(response) => {
                        if response.success {
                            if provider::persist_thread_session_from_response(
                                provider,
                                &response,
                                &mut thread,
                            ) {
                                thread.updated_at = workspace::now_rfc3339()?;
                                workspace::save_thread(root, &thread)?;
                            }
                            match provider::parse_action_envelope_response(provider, &response) {
                                Ok(envelope) => {
                                    for warning in &envelope.warnings {
                                        eprintln!("  Provider warning: {warning}");
                                    }

                                    match apply_agent_action_envelope(
                                        root, provider, &doc, &content, envelope,
                                    ) {
                                        Ok(summary) => {
                                            processed += summary.total();
                                            eprintln!(
                                                "  Applied {} action(s): {} repl(y/ies), {} proposal(s), {} thread(s), {} noop(s).",
                                                summary.total(),
                                                summary.replies,
                                                summary.proposals,
                                                summary.threads,
                                                summary.noops
                                            );
                                        }
                                        Err(e) => {
                                            eprintln!("  Error applying action envelope: {e}");
                                            errors += 1;
                                        }
                                    }
                                }
                                Err(envelope_error) => {
                                    match provider::parse_feedback_response(provider, &response) {
                                        Ok(feedback) => {
                                            eprintln!(
                                            "  Provider did not return an action envelope ({envelope_error}); saving plain feedback reply."
                                        );
                                            if let Err(e) = write_feedback_reply(
                                                root,
                                                &mut thread,
                                                provider,
                                                &feedback,
                                            ) {
                                                eprintln!("  Error writing reply: {e}");
                                                errors += 1;
                                            } else {
                                                processed += 1;
                                            }
                                        }
                                        Err(e) => {
                                            eprintln!("  Error parsing response: {e}");
                                            errors += 1;
                                        }
                                    }
                                }
                            }
                        } else {
                            eprintln!("  Provider returned non-zero exit code.");
                            if !response.stderr.is_empty() {
                                eprintln!("  stderr: {}", response.stderr.trim());
                            }
                            errors += 1;
                        }
                    }
                    Err(e) => {
                        eprintln!("  Error executing provider: {e}");
                        errors += 1;
                    }
                }
            }
            _ => {
                // Ignore other event types
            }
        }
    }

    let now = workspace::now_rfc3339()?;
    cursor.last_seen_event_id = last_event_id;
    cursor.last_synced_at = Some(now);
    cursor.last_sync_status = Some(if errors > 0 {
        format!("completed_with_errors ({errors} error(s))")
    } else {
        "ok".into()
    });
    workspace::save_agent_cursor(root, &cursor)?;

    eprintln!("Sync complete: {processed} action(s) applied, {errors} error(s).");
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn compute_unified_diff(before: &str, after: &str) -> String {
    TextDiff::from_lines(before, after)
        .unified_diff()
        .context_radius(2)
        .header("before", "after")
        .to_string()
}

fn summarize(assistant_message: &str, provider_name: &str) -> String {
    let normalized = assistant_message.replace('\n', " ").trim().to_string();
    if normalized.is_empty() {
        return format!("Proposal from {provider_name}");
    }
    if normalized.len() > 96 {
        format!("{}...", &normalized[..93])
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", workspace::next_id("test").unwrap()))
    }

    #[test]
    fn applies_mixed_agent_action_envelope() {
        let root = unique_temp_dir("margent-actions-envelope");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nOpening line.\nSecond line.\n").expect("write doc");

        workspace::ensure_workspace_layout(&root).expect("init layout");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document =
            workspace::upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let anchor = workspace::build_anchor_from_quote(&document, &content, "Opening line.", 1)
            .expect("build anchor");
        let thread = workspace::create_thread(
            &root,
            &document,
            "",
            "Make the opener more direct.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("create thread");
        let first_message_id = thread.messages[0].id.clone();

        let envelope = AgentActionEnvelope {
            status: "ok".into(),
            warnings: Vec::new(),
            actions: vec![
                AgentAction::ReplyToThread {
                    thread_id: thread.id.clone(),
                    reply_to_message_id: Some(first_message_id),
                    body: "I tightened the opener in the proposal.".into(),
                },
                AgentAction::ProposeRevision {
                    thread_id: thread.id.clone(),
                    assistant_message: "Revised the opening sentence.".into(),
                    response_mode: Some("updated_document".into()),
                    updated_document_text: Some(
                        "# Draft\n\nOpening line revised.\nSecond line.\n".into(),
                    ),
                    unified_diff: None,
                    resolve_thread_ids: vec![thread.id.clone()],
                },
                AgentAction::AddThread {
                    document_id: None,
                    relative_path: None,
                    quote: "Second line.".into(),
                    quote_occurrence: 1,
                    title: Some("Second note".into()),
                    body: "This line could use a concrete detail.".into(),
                    tags: vec!["agent-review".into()],
                },
                AgentAction::Noop {
                    reason: Some("No other issues.".into()),
                },
            ],
        };

        let summary =
            apply_agent_action_envelope(&root, Provider::Codex, &document, &content, envelope)
                .expect("apply action envelope");

        assert_eq!(
            summary,
            AppliedAgentActionSummary {
                replies: 1,
                proposals: 1,
                threads: 1,
                noops: 1,
            }
        );

        let updated_thread = workspace::load_thread(&root, &thread.id).expect("load thread");
        assert_eq!(updated_thread.messages.len(), 2);
        assert_eq!(updated_thread.linked_proposal_ids.len(), 1);

        let proposals = workspace::load_all_proposals(&root).expect("load proposals");
        assert_eq!(proposals.len(), 1);
        assert_eq!(
            proposals[0].updated_document_text.as_deref(),
            Some("# Draft\n\nOpening line revised.\nSecond line.\n")
        );
        assert_eq!(proposals[0].resolve_thread_ids, vec![thread.id.clone()]);

        let threads = workspace::load_threads_sorted(&root, &document.id).expect("load threads");
        let added_thread = threads
            .iter()
            .find(|candidate| candidate.title == "Second note")
            .expect("new thread exists");
        assert_eq!(added_thread.tags, vec!["agent-review"]);
        assert_eq!(added_thread.anchor.quote, "Second line.");

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn codify_writes_review_memory_and_advances_cursor() {
        let root = unique_temp_dir("margent-codify");
        fs::create_dir_all(&root).expect("create temp root");
        workspace::ensure_workspace_layout(&root).expect("init layout");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nOpening line.\n").expect("write doc");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document =
            workspace::upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let anchor = workspace::build_anchor_from_quote(&document, &content, "Opening line.", 1)
            .expect("build anchor");
        let thread = workspace::create_thread(
            &root,
            &document,
            "Opening",
            "Make the opener direct.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("create thread");
        workspace::resolve_thread(&root, &thread.id).expect("resolve thread");

        let bin_dir = root.join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        let codex_bin = bin_dir.join("codex");
        fs::write(
            &codex_bin,
            "#!/bin/sh\ncat >/dev/null\nprintf '# Margent Review Memory\\n\\n- Keep openers direct.\\n'\n",
        )
        .expect("write fake codex");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(&codex_bin)
                .expect("fake codex metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&codex_bin, permissions).expect("chmod fake codex");
        }

        let previous_path = env::var_os("PATH");
        let mut paths = vec![bin_dir.clone()];
        if let Some(previous_path) = previous_path.as_ref() {
            paths.extend(env::split_paths(previous_path));
        }
        let joined_path = env::join_paths(paths).expect("join path");
        env::set_var("PATH", joined_path);

        let result = run_codify(&root, Provider::Codex, false).expect("run codify");

        if let Some(previous_path) = previous_path {
            env::set_var("PATH", previous_path);
        } else {
            env::remove_var("PATH");
        }

        assert_eq!(result.relevant_events, 1);
        assert!(result.changed);
        assert_eq!(
            fs::read_to_string(root.join(".mdreview/memory.md")).expect("read memory"),
            "# Margent Review Memory\n\n- Keep openers direct.\n"
        );

        let cursor = workspace::load_agent_cursor(&root, CODIFY_AGENT_ID)
            .expect("load codify cursor")
            .expect("codify cursor");
        assert_eq!(cursor.last_sync_status.as_deref(), Some("ok"));
        assert_eq!(
            cursor.last_seen_event_id.as_deref(),
            result.last_seen_event_id.as_deref()
        );

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }
}
