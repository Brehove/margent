use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::models::document::DocumentRecord;
use crate::models::thread::{
    AnchorRecord, MessageRecord, ThreadRecord, ThreadSummaryRecord, CURRENT_THREAD_SCHEMA_VERSION,
};

use super::{anchor_service, file_service};

pub fn load_threads(workspace_root: &str, document_id: &str) -> Result<Vec<ThreadRecord>, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let threads_dir = mdreview_path.join("threads");
    let mut threads = Vec::new();

    for entry in fs::read_dir(&threads_dir)
        .map_err(|error| format!("Unable to read {}: {error}", threads_dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect thread records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if let Some(thread) = file_service::read_optional_json::<ThreadRecord>(&path)? {
            let thread = normalize_thread_record(thread);
            if thread.document_id == document_id {
                threads.push(thread);
            }
        }
    }

    threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(threads)
}

pub fn load_all_threads(workspace_root: &str) -> Result<Vec<ThreadRecord>, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let threads_dir = mdreview_path.join("threads");
    let mut threads = Vec::new();

    for entry in fs::read_dir(&threads_dir)
        .map_err(|error| format!("Unable to read {}: {error}", threads_dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect thread records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if let Some(thread) = file_service::read_optional_json::<ThreadRecord>(&path)? {
            threads.push(normalize_thread_record(thread));
        }
    }

    threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(threads)
}

pub fn load_thread(workspace_root: &str, thread_id: &str) -> Result<ThreadRecord, String> {
    let root_path = Path::new(workspace_root);
    load_thread_record(root_path, thread_id)
}

pub fn thread_update_signature(workspace_root: &str, document_id: &str) -> Result<String, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let threads_dir = mdreview_path.join("threads");
    let mut matching_signatures = Vec::new();

    for entry in fs::read_dir(&threads_dir)
        .map_err(|error| format!("Unable to read {}: {error}", threads_dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect thread records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let Some(thread) = file_service::read_optional_json::<ThreadSummaryRecord>(&path)? else {
            continue;
        };

        if thread.document_id == document_id {
            matching_signatures.push(thread_signature_key(&path, &thread)?);
        }
    }

    matching_signatures.sort();
    Ok(matching_signatures.join("|"))
}

pub fn create_thread(
    workspace_root: &str,
    document_id: &str,
    title: &str,
    body: &str,
    anchor: AnchorRecord,
) -> Result<ThreadRecord, String> {
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        return Err("A thread needs an initial comment.".into());
    }

    let root_path = Path::new(workspace_root);
    let now = file_service::now_rfc3339()?;
    let thread_id = next_id("thread")?;
    let message_id = next_id("msg")?;
    let base_content_hash = anchor.base_content_hash.clone();
    let tags = if anchor.kind == "document" {
        vec!["document".into()]
    } else {
        Vec::new()
    };

    let thread = ThreadRecord {
        schema_version: CURRENT_THREAD_SCHEMA_VERSION,
        id: thread_id.clone(),
        document_id: document_id.to_string(),
        status: "open".into(),
        created_at: now.clone(),
        updated_at: now.clone(),
        created_by: "user".into(),
        title: title.to_string(),
        tags,
        anchor,
        created_content_hash: Some(base_content_hash.clone()),
        last_reanchor_content_hash: Some(base_content_hash),
        review_round: None,
        review_done: false,
        messages: vec![MessageRecord {
            id: message_id,
            thread_id: thread_id.clone(),
            author_type: "user".into(),
            author_name: "You".into(),
            agent_id: None,
            adapter_id: None,
            reply_to_message_id: None,
            created_at: now.clone(),
            body: trimmed_body.to_string(),
            kind: "comment".into(),
        }],
        linked_proposal_ids: Vec::new(),
        provider_sessions: std::collections::HashMap::new(),
    };

    save_thread_record(root_path, &thread)?;
    append_event(
        root_path,
        "thread.created",
        Some(&thread.id),
        Some(document_id),
        None,
        Some(trimmed_body),
    )?;

    Ok(thread)
}

pub fn reattach_document_threads(
    workspace_root: &Path,
    document_record: &DocumentRecord,
    content: &str,
) -> Result<(), String> {
    let mdreview_path = file_service::ensure_workspace_layout(workspace_root)?;
    let threads_dir = mdreview_path.join("threads");

    for entry in fs::read_dir(&threads_dir)
        .map_err(|error| format!("Unable to read {}: {error}", threads_dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect thread records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let Some(mut thread) = file_service::read_optional_json::<ThreadRecord>(&path)? else {
            continue;
        };

        if thread.document_id != document_record.id {
            continue;
        }

        let original_anchor = thread.anchor.clone();
        anchor_service::reattach_anchor(
            &mut thread.anchor,
            content,
            &document_record.heading_index,
        );

        let reanchor_hash_changed = thread.last_reanchor_content_hash.as_deref()
            != Some(document_record.current_content_hash.as_str());
        let was_legacy = thread.schema_version < CURRENT_THREAD_SCHEMA_VERSION
            || thread.last_reanchor_content_hash.is_none()
            || thread.created_content_hash.is_none();
        if thread.anchor != original_anchor || reanchor_hash_changed || was_legacy {
            thread.schema_version = CURRENT_THREAD_SCHEMA_VERSION;
            if thread.created_content_hash.is_none() {
                thread.created_content_hash = Some(original_anchor.base_content_hash.clone());
            }
            thread.last_reanchor_content_hash = Some(document_record.current_content_hash.clone());
            save_thread_record(workspace_root, &thread)?;
        }
    }

    Ok(())
}

pub fn add_thread_message(
    workspace_root: &str,
    thread_id: &str,
    body: &str,
    kind: &str,
) -> Result<ThreadRecord, String> {
    add_thread_message_with_author(
        workspace_root,
        thread_id,
        body,
        kind,
        "user",
        "You",
        None,
        None,
        None,
    )
}

pub fn add_agent_thread_message(
    workspace_root: &str,
    thread_id: &str,
    body: &str,
    kind: &str,
    author_name: &str,
    agent_id: &str,
) -> Result<ThreadRecord, String> {
    add_thread_message_with_author(
        workspace_root,
        thread_id,
        body,
        kind,
        "agent",
        author_name,
        Some(agent_id),
        Some(agent_id),
        None,
    )
}

pub fn add_system_thread_message(
    workspace_root: &str,
    thread_id: &str,
    body: &str,
) -> Result<ThreadRecord, String> {
    add_thread_message_with_author(
        workspace_root,
        thread_id,
        body,
        "system",
        "system",
        "System",
        None,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn add_thread_message_with_author(
    workspace_root: &str,
    thread_id: &str,
    body: &str,
    kind: &str,
    author_type: &str,
    author_name: &str,
    agent_id: Option<&str>,
    adapter_id: Option<&str>,
    reply_to_message_id: Option<&str>,
) -> Result<ThreadRecord, String> {
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        return Err("Replies cannot be empty.".into());
    }

    let root_path = Path::new(workspace_root);
    let mut thread = load_thread_record(root_path, thread_id)?;
    let now = file_service::now_rfc3339()?;

    thread.messages.push(MessageRecord {
        id: next_id("msg")?,
        thread_id: thread.id.clone(),
        author_type: author_type.into(),
        author_name: author_name.into(),
        agent_id: agent_id.map(str::to_string),
        adapter_id: adapter_id.map(str::to_string),
        reply_to_message_id: reply_to_message_id.map(str::to_string),
        created_at: now.clone(),
        body: trimmed_body.to_string(),
        kind: kind.to_string(),
    });
    thread.updated_at = now;

    save_thread_record(root_path, &thread)?;
    append_event(
        root_path,
        "thread.message_added",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        Some(trimmed_body),
    )?;

    Ok(thread)
}

pub fn resolve_thread(workspace_root: &str, thread_id: &str) -> Result<ThreadRecord, String> {
    let root_path = Path::new(workspace_root);
    let mut thread = load_thread_record(root_path, thread_id)?;

    if thread.status == "resolved" {
        return Err("Thread is already resolved.".into());
    }

    let now = file_service::now_rfc3339()?;
    thread.status = "resolved".into();
    thread.updated_at = now;

    save_thread_record(root_path, &thread)?;
    append_event(
        root_path,
        "thread.resolved",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        None,
    )?;

    Ok(thread)
}

pub fn delete_thread(workspace_root: &str, thread_id: &str) -> Result<ThreadRecord, String> {
    let root_path = Path::new(workspace_root);
    let thread = load_thread_record(root_path, thread_id)?;
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let path = mdreview_path
        .join("threads")
        .join(format!("{thread_id}.json"));

    fs::remove_file(&path).map_err(|e| format!("Unable to delete {}: {e}", path.display()))?;

    append_event(
        root_path,
        "thread.deleted",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        Some(&thread.title),
    )?;

    Ok(thread)
}

pub fn reopen_thread(workspace_root: &str, thread_id: &str) -> Result<ThreadRecord, String> {
    let root_path = Path::new(workspace_root);
    let mut thread = load_thread_record(root_path, thread_id)?;

    if thread.status == "open" {
        return Err("Thread is already open.".into());
    }

    let now = file_service::now_rfc3339()?;
    thread.status = "open".into();
    thread.updated_at = now;

    save_thread_record(root_path, &thread)?;
    append_event(
        root_path,
        "thread.reopened",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        None,
    )?;

    Ok(thread)
}

pub fn load_thread_record(workspace_root: &Path, thread_id: &str) -> Result<ThreadRecord, String> {
    let thread_path = thread_path(workspace_root, thread_id)?;
    file_service::read_optional_json::<ThreadRecord>(&thread_path)?
        .map(normalize_thread_record)
        .ok_or_else(|| format!("Thread {thread_id} was not found."))
}

pub fn save_thread_record(workspace_root: &Path, thread: &ThreadRecord) -> Result<(), String> {
    let thread_path = thread_path(workspace_root, &thread.id)?;
    let normalized = normalize_thread_record(thread.clone());
    file_service::write_json_atomic(&thread_path, &normalized)
}

fn normalize_thread_record(mut normalized: ThreadRecord) -> ThreadRecord {
    normalized.schema_version = CURRENT_THREAD_SCHEMA_VERSION;
    if normalized.anchor.kind.trim().is_empty() {
        normalized.anchor.kind = "text_span".into();
    }
    if normalized.created_content_hash.is_none() {
        normalized.created_content_hash = Some(normalized.anchor.base_content_hash.clone());
    }
    if normalized.last_reanchor_content_hash.is_none() {
        normalized.last_reanchor_content_hash = Some(normalized.anchor.base_content_hash.clone());
    }
    normalized
}

fn thread_path(workspace_root: &Path, thread_id: &str) -> Result<PathBuf, String> {
    let mdreview_path = file_service::ensure_workspace_layout(workspace_root)?;
    Ok(mdreview_path
        .join("threads")
        .join(format!("{thread_id}.json")))
}

fn thread_signature_key(path: &Path, thread: &ThreadSummaryRecord) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?
        .as_millis();

    Ok(format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        thread.anchor.confidence,
        thread.anchor.state,
        thread.id,
        thread.linked_proposal_ids.join(","),
        thread
            .last_reanchor_content_hash
            .as_deref()
            .unwrap_or_default(),
        thread.review_done,
        thread.status,
        thread.updated_at,
        modified,
        metadata.len()
    ))
}

pub fn append_event(
    workspace_root: &Path,
    event_type: &str,
    thread_id: Option<&str>,
    document_id: Option<&str>,
    proposal_id: Option<&str>,
    body: Option<&str>,
) -> Result<String, String> {
    let mdreview_path = file_service::ensure_workspace_layout(workspace_root)?;
    let event_path = mdreview_path.join("events.ndjson");
    let timestamp = file_service::now_rfc3339()?;
    let event_id = next_id("evt")?;

    file_service::append_ndjson(
        &event_path,
        &json!({
            "id": event_id,
            "timestamp": timestamp,
            "eventType": event_type,
            "threadId": thread_id,
            "documentId": document_id,
            "proposalId": proposal_id,
            "body": body,
        }),
    )?;

    Ok(event_id)
}

pub fn next_id(prefix: &str) -> Result<String, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Unable to compute system time: {error}"))?
        .as_micros();
    Ok(format!("{prefix}_{nonce}"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::services::{file_service, workspace_service};

    #[test]
    fn create_thread_tags_document_anchors() {
        let workspace_root = unique_temp_dir("margent-document-anchor-tag");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let document_path = workspace_root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nWhole document.\n").expect("write document");
        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "draft.md")
            .expect("document");
        let content = fs::read_to_string(&document_path).expect("read document");

        let thread = create_thread(
            workspace_root.to_str().expect("root str"),
            &document.id,
            "Document comment",
            "Review the whole draft.",
            AnchorRecord {
                quote: "Entire document: draft.md".into(),
                prefix_context: String::new(),
                suffix_context: String::new(),
                start_offset_utf16: 0,
                end_offset_utf16: 0,
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 1,
                heading_path: Vec::new(),
                block_fingerprint: String::new(),
                base_content_hash: file_service::content_hash(&content),
                kind: "document".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
        )
        .expect("create document thread");

        assert!(thread.tags.contains(&"document".to_string()));

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn thread_update_signature_changes_for_matching_document_threads_only() {
        let workspace_root = unique_temp_dir("margent-thread-signature-test");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let first_document_path = workspace_root.join("first.md");
        let second_document_path = workspace_root.join("second.md");
        fs::write(&first_document_path, "Alpha beta\n").expect("write first document");
        fs::write(&second_document_path, "Gamma delta\n").expect("write second document");

        let workspace =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let first_document = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "first.md")
            .expect("first document");
        let second_document = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "second.md")
            .expect("second document");

        let first_thread = create_thread(
            workspace_root.to_str().expect("root str"),
            &first_document.id,
            "beta",
            "Tighten this phrase.",
            AnchorRecord {
                quote: "beta".into(),
                prefix_context: "Alpha ".into(),
                suffix_context: "\n".into(),
                start_offset_utf16: 6,
                end_offset_utf16: 10,
                start_line: 1,
                start_column: 7,
                end_line: 1,
                end_column: 11,
                heading_path: Vec::new(),
                block_fingerprint: "sha256:first".into(),
                base_content_hash: file_service::content_hash("Alpha beta\n"),
                kind: "text_span".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
        )
        .expect("create first thread");

        let first_signature_before = thread_update_signature(
            workspace_root.to_str().expect("root str"),
            &first_document.id,
        )
        .expect("first signature before");

        add_thread_message(
            workspace_root.to_str().expect("root str"),
            &first_thread.id,
            "Adding context.",
            "reply",
        )
        .expect("reply to first thread");

        let first_signature_after = thread_update_signature(
            workspace_root.to_str().expect("root str"),
            &first_document.id,
        )
        .expect("first signature after");

        assert_ne!(first_signature_before, first_signature_after);

        create_thread(
            workspace_root.to_str().expect("root str"),
            &second_document.id,
            "delta",
            "Second document thread.",
            AnchorRecord {
                quote: "delta".into(),
                prefix_context: "Gamma ".into(),
                suffix_context: "\n".into(),
                start_offset_utf16: 6,
                end_offset_utf16: 11,
                start_line: 1,
                start_column: 7,
                end_line: 1,
                end_column: 12,
                heading_path: Vec::new(),
                block_fingerprint: "sha256:second".into(),
                base_content_hash: file_service::content_hash("Gamma delta\n"),
                kind: "text_span".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
        )
        .expect("create second thread");

        let first_signature_final = thread_update_signature(
            workspace_root.to_str().expect("root str"),
            &first_document.id,
        )
        .expect("first signature final");

        assert_eq!(first_signature_after, first_signature_final);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn add_thread_message_upgrades_legacy_thread_records_on_write() {
        let workspace_root = unique_temp_dir("margent-legacy-thread-upgrade");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let mdreview =
            file_service::ensure_workspace_layout(&workspace_root).expect("workspace layout");
        let legacy_thread_id = "thread_legacy";
        let legacy_thread_path = mdreview
            .join("threads")
            .join(format!("{legacy_thread_id}.json"));

        fs::write(
            &legacy_thread_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "id": legacy_thread_id,
                "documentId": "doc_legacy",
                "status": "open",
                "createdAt": "2026-03-20T12:00:00Z",
                "updatedAt": "2026-03-20T12:00:00Z",
                "createdBy": "user",
                "title": "Legacy thread",
                "tags": [],
                "anchor": {
                    "quote": "legacy",
                    "prefixContext": "",
                    "suffixContext": "",
                    "startOffsetUtf16": 0,
                    "endOffsetUtf16": 6,
                    "startLine": 1,
                    "startColumn": 1,
                    "endLine": 1,
                    "endColumn": 7,
                    "headingPath": [],
                    "blockFingerprint": "sha256:legacy",
                    "baseContentHash": "sha256:legacy",
                    "state": "attached",
                    "confidence": 1.0
                },
                "messages": [{
                    "id": "msg_legacy",
                    "threadId": legacy_thread_id,
                    "authorType": "user",
                    "authorName": "You",
                    "agentId": null,
                    "adapterId": null,
                    "replyToMessageId": null,
                    "createdAt": "2026-03-20T12:00:00Z",
                    "body": "Legacy body",
                    "kind": "comment"
                }],
                "linkedProposalIds": []
            }))
            .expect("serialize legacy thread"),
        )
        .expect("write legacy thread");

        let updated = add_thread_message(
            workspace_root.to_str().expect("root str"),
            legacy_thread_id,
            "Upgraded reply",
            "reply",
        )
        .expect("reply to legacy thread");

        assert_eq!(updated.schema_version, CURRENT_THREAD_SCHEMA_VERSION);
        assert_eq!(updated.anchor.kind, "text_span");

        let persisted =
            load_thread_record(&workspace_root, legacy_thread_id).expect("load upgraded thread");
        assert_eq!(persisted.schema_version, CURRENT_THREAD_SCHEMA_VERSION);
        assert_eq!(persisted.anchor.kind, "text_span");
        assert_eq!(persisted.messages.len(), 2);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nonce}"))
    }
}
