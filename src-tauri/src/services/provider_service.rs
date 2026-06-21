use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use margent_core::provider_parse;
use margent_core::provider_readiness::ProviderKind;
use serde::Serialize;
use wait_timeout::ChildExt;

use crate::models::document::DocumentRecord;
use crate::models::proposal::ProposalRecord;
use crate::models::provider::{
    ProviderDocumentAction, ProviderThreadAction, ProviderThreadActionResult, ThreadProvider,
};
use crate::models::thread::{AnchorRecord, ThreadRecord};

use super::{anchor_service, diff_service, file_service, thread_service, workspace_service};

const PROVIDER_TIMEOUT_SECONDS: u64 = 600;
pub const PROVIDER_STREAM_EVENT: &str = "margent://provider-stream";

fn provider_kind(provider: ThreadProvider) -> ProviderKind {
    match provider {
        ThreadProvider::Codex => ProviderKind::Codex,
        ThreadProvider::Claude => ProviderKind::Claude,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStreamEvent {
    pub run_id: String,
    pub provider: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProviderRunContext {
    pub run_id: String,
    pub workspace_root: String,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug)]
struct ProviderRunRecord {
    pid: u32,
    workspace_root: String,
    thread_id: Option<String>,
    provider_label: String,
}

#[derive(Clone, Default)]
pub struct ProviderRunRegistry {
    runs: Arc<Mutex<HashMap<String, ProviderRunRecord>>>,
}

impl ProviderRunRegistry {
    fn register(
        &self,
        run_context: &ProviderRunContext,
        provider: ThreadProvider,
        pid: u32,
    ) -> Result<(), String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Provider run registry is unavailable.".to_string())?;
        runs.insert(
            run_context.run_id.clone(),
            ProviderRunRecord {
                pid,
                workspace_root: run_context.workspace_root.clone(),
                thread_id: run_context.thread_id.clone(),
                provider_label: provider.display_name().to_string(),
            },
        );
        Ok(())
    }

    fn remove(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }

    fn take(&self, run_id: &str) -> Result<Option<ProviderRunRecord>, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Provider run registry is unavailable.".to_string())?;
        Ok(runs.remove(run_id))
    }
}

pub fn cancel_provider_run(registry: &ProviderRunRegistry, run_id: &str) -> Result<(), String> {
    let Some(record) = registry.take(run_id)? else {
        return Ok(());
    };

    terminate_process(record.pid);
    if let Some(thread_id) = record.thread_id.as_deref() {
        let body = format!(
            "{} run was stopped before it finished.",
            record.provider_label
        );
        let _ = thread_service::add_system_thread_message(&record.workspace_root, thread_id, &body);
    }

    Ok(())
}

fn terminate_process(pid: u32) {
    let pid = pid.to_string();
    let _ = Command::new("/bin/kill").args(["-TERM", &pid]).status();
    std::thread::sleep(Duration::from_millis(700));
    let _ = Command::new("/bin/kill").args(["-KILL", &pid]).status();
}

#[allow(dead_code)]
pub fn run_provider_thread_action(
    workspace_root: &str,
    document_id: &str,
    thread_id: &str,
    provider: ThreadProvider,
    action: ProviderThreadAction,
    instruction: &str,
    pass_name: Option<&str>,
) -> Result<ProviderThreadActionResult, String> {
    run_provider_thread_action_with_stream(
        workspace_root,
        document_id,
        None,
        thread_id,
        provider,
        action,
        instruction,
        pass_name,
        None,
        None,
        &mut |_| {},
    )
}

#[allow(clippy::too_many_arguments)]
pub fn run_provider_thread_action_with_stream(
    workspace_root: &str,
    document_id: &str,
    document_relative_path: Option<&str>,
    thread_id: &str,
    provider: ThreadProvider,
    action: ProviderThreadAction,
    instruction: &str,
    pass_name: Option<&str>,
    run_context: Option<ProviderRunContext>,
    registry: Option<&ProviderRunRegistry>,
    on_event: &mut dyn FnMut(ProviderStreamEvent),
) -> Result<ProviderThreadActionResult, String> {
    let root_path = Path::new(workspace_root);
    let (document_record, _document_path, document_content) =
        load_document_context(root_path, document_id, document_relative_path)?;
    let mut thread = thread_service::load_thread_record(root_path, thread_id)?;

    if thread.document_id != document_record.id
        && !retarget_thread_to_document_if_anchor_matches(
            root_path,
            &document_record,
            &document_content,
            &mut thread,
        )?
    {
        return Err(format!(
            "Thread {thread_id} does not belong to document {}.",
            document_record.relative_path
        ));
    }

    if is_document_thread(&thread) {
        normalize_document_thread_anchor_if_needed(
            root_path,
            &document_record,
            &document_content,
            &mut thread,
        )?;
        return run_existing_document_thread_action(
            workspace_root,
            root_path,
            &document_record,
            &document_content,
            thread,
            provider,
            action,
            instruction,
            pass_name,
            run_context,
            registry,
            on_event,
        );
    }

    refresh_thread_anchor_if_needed(root_path, &document_content, &document_record, &mut thread)?;

    match action {
        ProviderThreadAction::Feedback => {
            let prompt = build_feedback_prompt(
                &document_content,
                &document_record.relative_path,
                &thread,
                instruction,
            );
            let prompt = with_review_context(root_path, pass_name, prompt)?;
            let execution = execute_provider(
                provider,
                root_path,
                &prompt,
                thread
                    .provider_sessions
                    .get(provider.id())
                    .map(String::as_str),
                run_context.as_ref(),
                registry,
                on_event,
            )?;
            persist_thread_session_from_execution(root_path, provider, &execution, &mut thread)?;
            let feedback = parse_feedback_response(provider, &execution.response_text)?;
            let updated_thread = thread_service::add_agent_thread_message(
                workspace_root,
                &thread.id,
                &feedback,
                "reply",
                provider.display_name(),
                provider.id(),
            )?;

            Ok(ProviderThreadActionResult {
                thread: updated_thread,
                proposal: None,
            })
        }
        ProviderThreadAction::Revise => {
            if matches!(thread.anchor.state.as_str(), "detached" | "needs_review") {
                return Err(format!(
                    "This thread anchor is not reliable enough for a targeted {} revision.",
                    provider.display_name()
                ));
            }

            let target_text = extract_anchor_text(&document_content, &thread.anchor)?;
            let prompt = build_focused_revise_prompt(
                &document_record.relative_path,
                &thread,
                &target_text,
                instruction,
            );
            let prompt = with_review_context(root_path, pass_name, prompt)?;
            let execution = execute_provider(
                provider,
                root_path,
                &prompt,
                thread
                    .provider_sessions
                    .get(provider.id())
                    .map(String::as_str),
                run_context.as_ref(),
                registry,
                on_event,
            )?;
            persist_thread_session_from_execution(root_path, provider, &execution, &mut thread)?;
            let revision = parse_focused_revision_response(provider, &execution.response_text)?;
            let updated_document_text = replace_anchor_text(
                &document_content,
                &thread.anchor,
                &revision.replacement_text,
            )?;
            let proposal = write_revision_proposal(
                provider,
                root_path,
                &mut thread,
                &document_record,
                &document_content,
                &revision,
                updated_document_text,
            )?;
            let updated_thread = thread_service::load_thread_record(root_path, &thread.id)?;

            Ok(ProviderThreadActionResult {
                thread: updated_thread,
                proposal: Some(proposal),
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_existing_document_thread_action(
    workspace_root: &str,
    root_path: &Path,
    document_record: &DocumentRecord,
    document_content: &str,
    mut thread: ThreadRecord,
    provider: ThreadProvider,
    action: ProviderThreadAction,
    instruction: &str,
    pass_name: Option<&str>,
    run_context: Option<ProviderRunContext>,
    registry: Option<&ProviderRunRegistry>,
    on_event: &mut dyn FnMut(ProviderStreamEvent),
) -> Result<ProviderThreadActionResult, String> {
    match action {
        ProviderThreadAction::Feedback => {
            let prompt = build_document_thread_feedback_prompt(
                document_content,
                &document_record.relative_path,
                &thread,
                instruction,
            );
            let prompt = with_review_context(root_path, pass_name, prompt)?;
            let execution = execute_provider(
                provider,
                root_path,
                &prompt,
                thread
                    .provider_sessions
                    .get(provider.id())
                    .map(String::as_str),
                run_context.as_ref(),
                registry,
                on_event,
            )?;
            persist_thread_session_from_execution(root_path, provider, &execution, &mut thread)?;
            let feedback = parse_feedback_response(provider, &execution.response_text)?;
            let updated_thread = thread_service::add_agent_thread_message(
                workspace_root,
                &thread.id,
                &feedback,
                "reply",
                provider.display_name(),
                provider.id(),
            )?;

            Ok(ProviderThreadActionResult {
                thread: updated_thread,
                proposal: None,
            })
        }
        ProviderThreadAction::Revise => {
            let prompt = build_document_thread_revise_prompt(
                document_content,
                &document_record.relative_path,
                &thread,
                instruction,
            );
            let prompt = with_review_context(root_path, pass_name, prompt)?;
            let execution = execute_provider(
                provider,
                root_path,
                &prompt,
                thread
                    .provider_sessions
                    .get(provider.id())
                    .map(String::as_str),
                run_context.as_ref(),
                registry,
                on_event,
            )?;
            persist_thread_session_from_execution(root_path, provider, &execution, &mut thread)?;
            let revision = parse_document_revision_response(provider, &execution.response_text)?;
            let proposal = write_provider_revision_proposal(
                provider,
                root_path,
                &mut thread,
                document_record,
                document_content,
                &revision.assistant_message,
                &revision.resolve_thread_ids,
                revision.updated_document_text,
            )?;
            let updated_thread = thread_service::load_thread_record(root_path, &thread.id)?;

            Ok(ProviderThreadActionResult {
                thread: updated_thread,
                proposal: Some(proposal),
            })
        }
    }
}

#[allow(dead_code)]
pub fn run_provider_document_action(
    workspace_root: &str,
    document_id: &str,
    provider: ThreadProvider,
    action: ProviderDocumentAction,
    instruction: &str,
    pass_name: Option<&str>,
) -> Result<ProviderThreadActionResult, String> {
    run_provider_document_action_with_stream(
        workspace_root,
        document_id,
        None,
        provider,
        action,
        instruction,
        pass_name,
        None,
        None,
        &mut |_| {},
    )
}

#[allow(clippy::too_many_arguments)]
pub fn run_provider_document_action_with_stream(
    workspace_root: &str,
    document_id: &str,
    document_relative_path: Option<&str>,
    provider: ThreadProvider,
    action: ProviderDocumentAction,
    instruction: &str,
    pass_name: Option<&str>,
    run_context: Option<ProviderRunContext>,
    registry: Option<&ProviderRunRegistry>,
    on_event: &mut dyn FnMut(ProviderStreamEvent),
) -> Result<ProviderThreadActionResult, String> {
    let trimmed_instruction = instruction.trim();
    if trimmed_instruction.is_empty() {
        return Err("Document-level agent prompts need an instruction.".into());
    }

    let root_path = Path::new(workspace_root);
    let (document_record, _document_path, document_content) =
        load_document_context(root_path, document_id, document_relative_path)?;

    match action {
        ProviderDocumentAction::Feedback => {
            let prompt = build_document_feedback_prompt(
                &document_content,
                &document_record.relative_path,
                trimmed_instruction,
            );
            let prompt = with_review_context(root_path, pass_name, prompt)?;
            let mut thread = create_document_action_thread(
                workspace_root,
                &document_record,
                &document_content,
                provider,
                trimmed_instruction,
            )?;
            let run_context = attach_thread_to_run_context(run_context, &thread.id);
            let execution = execute_provider(
                provider,
                root_path,
                &prompt,
                thread
                    .provider_sessions
                    .get(provider.id())
                    .map(String::as_str),
                run_context.as_ref(),
                registry,
                on_event,
            )?;
            let feedback = parse_feedback_response(provider, &execution.response_text)?;
            persist_thread_session_from_execution(root_path, provider, &execution, &mut thread)?;
            thread = thread_service::add_agent_thread_message(
                workspace_root,
                &thread.id,
                &feedback,
                "reply",
                provider.display_name(),
                provider.id(),
            )?;

            Ok(ProviderThreadActionResult {
                thread,
                proposal: None,
            })
        }
        ProviderDocumentAction::Revise => {
            let prompt = build_document_revise_prompt(
                &document_content,
                &document_record.relative_path,
                trimmed_instruction,
            );
            let prompt = with_review_context(root_path, pass_name, prompt)?;
            let mut thread = create_document_action_thread(
                workspace_root,
                &document_record,
                &document_content,
                provider,
                trimmed_instruction,
            )?;
            let run_context = attach_thread_to_run_context(run_context, &thread.id);
            let execution = execute_provider(
                provider,
                root_path,
                &prompt,
                thread
                    .provider_sessions
                    .get(provider.id())
                    .map(String::as_str),
                run_context.as_ref(),
                registry,
                on_event,
            )?;
            let revision = parse_document_revision_response(provider, &execution.response_text)?;
            persist_thread_session_from_execution(root_path, provider, &execution, &mut thread)?;
            let proposal = write_provider_revision_proposal(
                provider,
                root_path,
                &mut thread,
                &document_record,
                &document_content,
                &revision.assistant_message,
                &revision.resolve_thread_ids,
                revision.updated_document_text,
            )?;
            let updated_thread = thread_service::load_thread_record(root_path, &thread.id)?;

            Ok(ProviderThreadActionResult {
                thread: updated_thread,
                proposal: Some(proposal),
            })
        }
    }
}

fn load_document_context(
    workspace_root: &Path,
    document_id: &str,
    document_relative_path: Option<&str>,
) -> Result<(DocumentRecord, PathBuf, String), String> {
    if let Some(record) =
        workspace_service::hydrate_document_record_by_id(workspace_root, document_id)?
    {
        return read_document_context_for_record(workspace_root, record);
    }

    if let Some(relative_path) = document_relative_path {
        let record = workspace_service::hydrate_document_record_by_relative_path(
            workspace_root,
            relative_path,
        )?;
        return read_document_context_for_record(workspace_root, record);
    }

    Err(format!("Document {document_id} was not found."))
}

fn read_document_context_for_record(
    workspace_root: &Path,
    record: DocumentRecord,
) -> Result<(DocumentRecord, PathBuf, String), String> {
    let document_path = file_service::resolve_document_path(workspace_root, &record.relative_path)?;
    let content = fs::read_to_string(&document_path)
        .map_err(|error| format!("Unable to read {}: {error}", document_path.display()))?;

    Ok((record, document_path, content))
}

fn retarget_thread_to_document_if_anchor_matches(
    workspace_root: &Path,
    document_record: &DocumentRecord,
    document_content: &str,
    thread: &mut ThreadRecord,
) -> Result<bool, String> {
    let original_document_id = thread.document_id.clone();

    if is_document_thread(thread) {
        let expected_quote = format!("Entire document: {}", document_record.relative_path);
        let current_content_hash = file_service::content_hash(document_content);
        if thread.anchor.quote != expected_quote
            && thread.anchor.base_content_hash != current_content_hash
        {
            return Ok(false);
        }

        normalize_document_thread_anchor_if_needed(
            workspace_root,
            document_record,
            document_content,
            thread,
        )?;
    } else {
        let original_anchor = thread.anchor.clone();
        anchor_service::reattach_anchor(
            &mut thread.anchor,
            document_content,
            &document_record.heading_index,
        );

        if thread.anchor.state != "attached" {
            thread.anchor = original_anchor;
            return Ok(false);
        }
    }

    thread.document_id = document_record.id.clone();
    thread.updated_at = file_service::now_rfc3339()?;
    thread_service::save_thread_record(workspace_root, thread)?;
    thread_service::append_event(
        workspace_root,
        "thread.document_retargeted",
        Some(&thread.id),
        Some(&document_record.id),
        None,
        Some(&format!("{original_document_id} -> {}", document_record.id)),
    )?;

    Ok(true)
}

fn with_review_context(
    workspace_root: &Path,
    pass_name: Option<&str>,
    prompt: String,
) -> Result<String, String> {
    let context = margent_core::review_context::load_review_context(workspace_root, pass_name)?;
    Ok(margent_core::review_context::prepend_review_context(
        prompt, &context,
    ))
}

fn attach_thread_to_run_context(
    run_context: Option<ProviderRunContext>,
    thread_id: &str,
) -> Option<ProviderRunContext> {
    run_context.map(|mut context| {
        context.thread_id = Some(thread_id.to_string());
        context
    })
}

fn refresh_thread_anchor_if_needed(
    workspace_root: &Path,
    content: &str,
    document_record: &DocumentRecord,
    thread: &mut ThreadRecord,
) -> Result<(), String> {
    let original_anchor = thread.anchor.clone();
    anchor_service::reattach_anchor(&mut thread.anchor, content, &document_record.heading_index);

    if thread.anchor != original_anchor {
        thread.updated_at = file_service::now_rfc3339()?;
        thread_service::save_thread_record(workspace_root, thread)?;
    }

    Ok(())
}

fn normalize_document_thread_anchor_if_needed(
    workspace_root: &Path,
    document_record: &DocumentRecord,
    document_content: &str,
    thread: &mut ThreadRecord,
) -> Result<(), String> {
    let mut changed = false;

    if thread.anchor.kind != "document" {
        thread.anchor.kind = "document".into();
        changed = true;
    }

    if thread.anchor.state != "attached" {
        thread.anchor.state = "attached".into();
        changed = true;
    }

    if thread.anchor.start_offset_utf16 != 0 || thread.anchor.end_offset_utf16 != 0 {
        thread.anchor.start_offset_utf16 = 0;
        thread.anchor.end_offset_utf16 = 0;
        thread.anchor.start_line = 1;
        thread.anchor.start_column = 1;
        thread.anchor.end_line = 1;
        thread.anchor.end_column = 1;
        changed = true;
    }

    let expected_quote = format!("Entire document: {}", document_record.relative_path);
    if thread.anchor.quote != expected_quote {
        thread.anchor.quote = expected_quote;
        changed = true;
    }

    let content_hash = file_service::content_hash(document_content);
    if thread.anchor.base_content_hash != content_hash {
        thread.anchor.base_content_hash = content_hash;
        changed = true;
    }

    if !thread.tags.iter().any(|tag| tag == "document") {
        thread.tags.push("document".into());
        changed = true;
    }

    if changed {
        thread.updated_at = file_service::now_rfc3339()?;
        thread_service::save_thread_record(workspace_root, thread)?;
    }

    Ok(())
}

fn is_document_thread(thread: &ThreadRecord) -> bool {
    thread.anchor.kind == "document" || thread.tags.iter().any(|tag| tag == "document")
}

fn create_document_action_thread(
    workspace_root: &str,
    document_record: &DocumentRecord,
    document_content: &str,
    provider: ThreadProvider,
    instruction: &str,
) -> Result<ThreadRecord, String> {
    let anchor = build_document_anchor(document_record, document_content);
    let title = format!(
        "Document check with {}: {}",
        provider.display_name(),
        summarize_instruction_for_title(instruction)
    );
    let mut thread = thread_service::create_thread(
        workspace_root,
        &document_record.id,
        &title,
        instruction,
        anchor,
    )?;

    if !thread.tags.iter().any(|tag| tag == "document") {
        thread.tags.push("document".into());
        thread_service::save_thread_record(Path::new(workspace_root), &thread)?;
    }

    Ok(thread)
}

fn build_document_anchor(document_record: &DocumentRecord, document_content: &str) -> AnchorRecord {
    AnchorRecord {
        quote: format!("Entire document: {}", document_record.relative_path),
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
        base_content_hash: file_service::content_hash(document_content),
        kind: "document".into(),
        footnote: None,
        state: "attached".into(),
        confidence: 1.0,
    }
}

fn summarize_instruction_for_title(instruction: &str) -> String {
    let normalized = instruction.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return "document review".into();
    }

    let mut chars = normalized.chars();
    let summary = chars.by_ref().take(52).collect::<String>();
    if chars.next().is_some() {
        format!("{summary}...")
    } else {
        normalized
    }
}

fn build_feedback_prompt(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
    instruction: &str,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("You are a writing review assistant for Margent, a Markdown review tool.\n\n");
    prompt.push_str("## Document\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n\n"));
    prompt.push_str("```markdown\n");
    prompt.push_str(document_content);
    if !document_content.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");
    push_thread_context(&mut prompt, thread);
    prompt.push_str("## Your Task\n\n");
    prompt.push_str(
        "Provide constructive feedback on the highlighted passage in the context of this review thread. \
         Consider the conversation so far and offer a thoughtful reply that helps improve the writing. \
         Respond with ONLY your feedback text. Do not wrap the whole response in JSON or a code fence.\n",
    );
    push_optional_instruction(&mut prompt, instruction);
    prompt
}

fn build_focused_revise_prompt(
    document_path: &str,
    thread: &ThreadRecord,
    target_text: &str,
    instruction: &str,
) -> String {
    let mut prompt = String::new();
    prompt
        .push_str("You are a writing revision assistant for Margent, a Markdown review tool.\n\n");
    prompt.push_str("## Target Passage\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n"));
    if !thread.anchor.heading_path.is_empty() {
        prompt.push_str(&format!(
            "**Heading path:** {}\n",
            thread.anchor.heading_path.join(" > ")
        ));
    }
    prompt.push_str(&format!(
        "**Lines:** {}:{} - {}:{}\n\n",
        thread.anchor.start_line,
        thread.anchor.start_column,
        thread.anchor.end_line,
        thread.anchor.end_column
    ));
    prompt.push_str("```markdown\n");
    prompt.push_str(target_text);
    if !target_text.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");
    push_thread_context(&mut prompt, thread);
    prompt.push_str("## Your Task\n\n");
    prompt.push_str(
        "Revise ONLY the target passage above to address the feedback. \
         You MUST respond with ONLY a valid JSON object in this exact shape, with no Markdown fence and no prose before or after it:\n\n\
         {\"assistantMessage\":\"Brief description of what you changed\",\"replacementText\":\"The revised text that should replace the target passage\",\"resolveThreadIds\":[]}\n\n\
         Important:\n\
         - Return ONLY the replacement passage in replacementText, not the full document\n\
         - The replacement text will be spliced back into the original document at the anchored range\n\
         - Preserve Markdown formatting and the surrounding voice of the document\n\
         - resolveThreadIds is optional; omit it or return an empty array if no thread should be resolved\n\
         - The response MUST be valid JSON\n",
    );
    push_optional_instruction(&mut prompt, instruction);
    prompt
}

fn build_document_feedback_prompt(
    document_content: &str,
    document_path: &str,
    instruction: &str,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("You are a whole-document writing review assistant for Margent, a Markdown review tool.\n\n");
    prompt.push_str("## Document\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n\n"));
    prompt.push_str("```markdown\n");
    prompt.push_str(document_content);
    if !document_content.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");
    prompt.push_str("## User Instruction\n\n");
    prompt.push_str(instruction.trim());
    prompt.push_str("\n\n## Your Task\n\n");
    prompt.push_str(
        "Review the entire Markdown document in light of the user instruction. \
         Respond with ONLY your feedback text. Do not wrap the whole response in JSON or a code fence. \
         Be concrete and useful, and refer to document-level patterns when that is more helpful than line-by-line notes.\n",
    );
    prompt
}

fn build_document_revise_prompt(
    document_content: &str,
    document_path: &str,
    instruction: &str,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("You are a whole-document writing revision assistant for Margent, a Markdown review tool.\n\n");
    prompt.push_str("## Document\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n\n"));
    prompt.push_str("```markdown\n");
    prompt.push_str(document_content);
    if !document_content.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");
    prompt.push_str("## User Instruction\n\n");
    prompt.push_str(instruction.trim());
    prompt.push_str("\n\n## Your Task\n\n");
    prompt.push_str(
        "Revise the entire Markdown document to satisfy the user instruction. \
         You MUST respond with a JSON object in this exact format:\n\n\
         ```json\n\
         {\n\
           \"assistantMessage\": \"Brief description of what you changed\",\n\
           \"updatedDocumentText\": \"The complete revised Markdown document\",\n\
           \"resolveThreadIds\": [\"Optional thread ids to resolve after the edit is applied\"]\n\
         }\n\
         ```\n\n\
         Important:\n\
         - Return the complete document in updatedDocumentText, not a patch or excerpt\n\
         - Preserve Markdown structure, links, front matter, headings, and citations unless the instruction explicitly asks to change them\n\
         - Do not include commentary outside the JSON object\n\
         - resolveThreadIds is optional; omit it or return an empty array if no thread should be resolved\n\
         - The response MUST be valid JSON\n",
    );
    prompt
}

fn build_document_thread_feedback_prompt(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
    instruction: &str,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("You are a whole-document writing review assistant for Margent, a Markdown review tool.\n\n");
    prompt.push_str("## Document\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n\n"));
    prompt.push_str("```markdown\n");
    prompt.push_str(document_content);
    if !document_content.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");
    push_thread_context(&mut prompt, thread);
    prompt.push_str("## Your Task\n\n");
    prompt.push_str(
        "Continue this document-level review thread. Review the entire Markdown document in light of the conversation so far. \
         Respond with ONLY your feedback text. Do not wrap the whole response in JSON or a code fence.\n",
    );
    push_optional_instruction(&mut prompt, instruction);
    prompt
}

fn build_document_thread_revise_prompt(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
    instruction: &str,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("You are a whole-document writing revision assistant for Margent, a Markdown review tool.\n\n");
    prompt.push_str("## Document\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n\n"));
    prompt.push_str("```markdown\n");
    prompt.push_str(document_content);
    if !document_content.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");
    push_thread_context(&mut prompt, thread);
    prompt.push_str("## Your Task\n\n");
    prompt.push_str(
        "Revise the entire Markdown document to address this document-level review thread. \
         You MUST respond with a JSON object in this exact format:\n\n\
         ```json\n\
         {\n\
           \"assistantMessage\": \"Brief description of what you changed\",\n\
           \"updatedDocumentText\": \"The complete revised Markdown document\",\n\
           \"resolveThreadIds\": [\"Optional thread ids to resolve after the edit is applied\"]\n\
         }\n\
         ```\n\n\
         Important:\n\
         - Return the complete document in updatedDocumentText, not a patch or excerpt\n\
         - Preserve Markdown structure, links, front matter, headings, and citations unless the thread or instruction explicitly asks to change them\n\
         - Do not include commentary outside the JSON object\n\
         - The response MUST be valid JSON\n",
    );
    push_optional_instruction(&mut prompt, instruction);
    prompt
}

fn push_thread_context(prompt: &mut String, thread: &ThreadRecord) {
    prompt.push_str("## Review Thread\n\n");
    prompt.push_str(&format!("**Thread ID:** {}\n", thread.id));
    prompt.push_str(&format!("**Title:** {}\n", thread.title));
    prompt.push_str(&format!("**Status:** {}\n", thread.status));
    prompt.push_str(&format!(
        "**Anchor quote:** \"{}\"\n\n",
        thread.anchor.quote
    ));
    prompt.push_str("### Conversation\n\n");

    for message in &thread.messages {
        let role = if message.agent_id.is_some() {
            format!(
                "[{}]",
                message
                    .agent_id
                    .as_deref()
                    .unwrap_or(message.author_name.as_str())
            )
        } else {
            format!("[{}]", message.author_name)
        };
        prompt.push_str(&format!("{role}: {}\n\n", message.body));
    }
}

fn push_optional_instruction(prompt: &mut String, instruction: &str) {
    let trimmed = instruction.trim();
    if trimmed.is_empty() {
        return;
    }

    prompt.push_str("\n## Additional Instructions\n\n");
    prompt.push_str(trimmed);
    prompt.push('\n');
}

struct ProviderExecution {
    response_text: String,
    session_id: Option<String>,
}

fn execute_provider(
    provider: ThreadProvider,
    workspace_root: &Path,
    prompt: &str,
    resume_session_id: Option<&str>,
    run_context: Option<&ProviderRunContext>,
    registry: Option<&ProviderRunRegistry>,
    on_event: &mut dyn FnMut(ProviderStreamEvent),
) -> Result<ProviderExecution, String> {
    let provider_binary = resolve_provider_binary(provider)?;
    let mut command = Command::new(&provider_binary);
    configure_provider_environment(&mut command, provider);
    configure_provider_command(
        &mut command,
        provider,
        resume_session_id,
        run_context.is_some(),
    );

    if run_context.is_some() {
        return execute_provider_streaming(
            provider,
            command,
            workspace_root,
            prompt,
            run_context,
            registry,
            on_event,
        );
    }

    execute_provider_buffered(provider, command, workspace_root, prompt)
}

fn execute_provider_buffered(
    provider: ThreadProvider,
    mut command: Command,
    workspace_root: &Path,
    prompt: &str,
) -> Result<ProviderExecution, String> {
    let mut child = command
        .current_dir(workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start {}: {error}", provider.display_name()))?;

    {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            format!(
                "Unable to open {} stdin for prompt delivery.",
                provider.display_name()
            )
        })?;
        stdin.write_all(prompt.as_bytes()).map_err(|error| {
            let _ = child.kill();
            format!(
                "Unable to write prompt to {} stdin: {error}",
                provider.display_name()
            )
        })?;
    }

    let timed_out = child
        .wait_timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECONDS))
        .map_err(|error| format!("Unable to wait for {}: {error}", provider.display_name()))?
        .is_none();

    if timed_out {
        let _ = child.kill();
    }

    let output = child.wait_with_output().map_err(|error| {
        format!(
            "Unable to capture {} output: {error}",
            provider.display_name()
        )
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if timed_out {
        return Err(format!(
            "{} timed out after {PROVIDER_TIMEOUT_SECONDS} seconds.",
            provider.display_name()
        ));
    }

    if !output.status.success() {
        let mut message = format!(
            "{} exited with status {}.",
            provider.display_name(),
            output.status
        );
        if !stderr.is_empty() {
            message.push_str(&format!("\nstderr: {stderr}"));
        }
        if !stdout.is_empty() {
            message.push_str(&format!("\nstdout: {stdout}"));
        }
        return Err(message);
    }

    if stdout.is_empty() {
        return Err(format!(
            "{} returned empty output.",
            provider.display_name()
        ));
    }

    Ok(ProviderExecution {
        response_text: provider_response_text(provider, &stdout),
        session_id: extract_session_id(provider, &stdout, &stderr),
    })
}

fn execute_provider_streaming(
    provider: ThreadProvider,
    mut command: Command,
    workspace_root: &Path,
    prompt: &str,
    run_context: Option<&ProviderRunContext>,
    registry: Option<&ProviderRunRegistry>,
    on_event: &mut dyn FnMut(ProviderStreamEvent),
) -> Result<ProviderExecution, String> {
    let provider_binary = resolve_provider_binary(provider)?;
    let mut child = command
        .current_dir(workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to start {} at {}: {error}",
                provider.display_name(),
                provider_binary.display()
            )
        })?;

    if let (Some(context), Some(registry)) = (run_context, registry) {
        registry.register(context, provider, child.id())?;
    }

    {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            format!(
                "Unable to open {} stdin for prompt delivery.",
                provider.display_name()
            )
        })?;
        stdin.write_all(prompt.as_bytes()).map_err(|error| {
            let _ = child.kill();
            format!(
                "Unable to write prompt to {} stdin: {error}",
                provider.display_name()
            )
        })?;
    }

    let stdout_pipe = child.stdout.take().ok_or_else(|| {
        format!(
            "Unable to open {} stdout for streaming.",
            provider.display_name()
        )
    })?;
    let stderr_pipe = child.stderr.take().ok_or_else(|| {
        format!(
            "Unable to open {} stderr for streaming.",
            provider.display_name()
        )
    })?;
    let (stdout_tx, stdout_rx) = mpsc::channel::<Result<Option<String>, String>>();
    let stdout_reader = std::thread::spawn(move || {
        let reader = BufReader::new(stdout_pipe);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if stdout_tx.send(Ok(Some(line))).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = stdout_tx.send(Err(error.to_string()));
                    return;
                }
            }
        }
        let _ = stdout_tx.send(Ok(None));
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr_pipe);
        let mut buffer = String::new();
        reader
            .read_to_string(&mut buffer)
            .map(|_| buffer)
            .map_err(|error| error.to_string())
    });

    let start = Instant::now();
    let mut stdout = String::new();
    let mut emitted_text = String::new();
    let mut stdout_done = false;
    let mut timed_out = false;
    let mut status: Option<ExitStatus> = None;

    while !stdout_done || status.is_none() {
        match stdout_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(Some(line))) => {
                stdout.push_str(&line);
                stdout.push('\n');
                if let (Some(context), Some(text)) =
                    (run_context, provider_stream_delta(provider, &line))
                {
                    let delta = stream_delta_suffix(&mut emitted_text, &text);
                    if !delta.is_empty() {
                        on_event(ProviderStreamEvent {
                            run_id: context.run_id.clone(),
                            provider: provider.id().to_string(),
                            phase: "delta".to_string(),
                            text: Some(delta),
                            message: None,
                        });
                    }
                }
            }
            Ok(Ok(None)) => {
                stdout_done = true;
            }
            Ok(Err(error)) => {
                stdout_done = true;
                if !stdout.trim().is_empty() {
                    stdout.push('\n');
                }
                stdout.push_str(&format!("[stdout read error: {error}]"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                stdout_done = true;
            }
        }

        if status.is_none() {
            status = child
                .try_wait()
                .map_err(|error| format!("Unable to poll {}: {error}", provider.display_name()))?;
        }

        if status.is_none() && start.elapsed() >= Duration::from_secs(PROVIDER_TIMEOUT_SECONDS) {
            timed_out = true;
            let _ = child.kill();
            status =
                Some(child.wait().map_err(|error| {
                    format!("Unable to stop {}: {error}", provider.display_name())
                })?);
        }
    }

    let _ = stdout_reader.join();
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("Unable to join {} stderr reader.", provider.display_name()))?
        .unwrap_or_else(|error| format!("[stderr read error: {error}]"));
    let status = match status {
        Some(status) => status,
        None => child
            .wait()
            .map_err(|error| format!("Unable to wait for {}: {error}", provider.display_name()))?,
    };

    if let (Some(context), Some(registry)) = (run_context, registry) {
        registry.remove(&context.run_id);
    }

    let stdout = stdout.trim().to_string();
    let stderr = stderr.trim().to_string();

    if timed_out {
        return Err(format!(
            "{} timed out after {PROVIDER_TIMEOUT_SECONDS} seconds.",
            provider.display_name()
        ));
    }

    if !status.success() {
        let mut message = format!("{} exited with status {status}.", provider.display_name());
        if !stderr.is_empty() {
            message.push_str(&format!("\nstderr: {stderr}"));
        }
        if !stdout.is_empty() {
            message.push_str(&format!("\nstdout: {stdout}"));
        }
        return Err(message);
    }

    if stdout.is_empty() {
        return Err(format!(
            "{} returned empty output.",
            provider.display_name()
        ));
    }

    Ok(ProviderExecution {
        response_text: provider_response_text(provider, &stdout),
        session_id: extract_session_id(provider, &stdout, &stderr),
    })
}

fn configure_provider_command(
    command: &mut Command,
    provider: ThreadProvider,
    resume_session_id: Option<&str>,
    stream: bool,
) {
    match provider {
        ThreadProvider::Codex => {
            if let Some(session_id) = resume_session_id {
                command.args(["exec", "resume"]);
                if stream {
                    command.arg("--json");
                }
                command.args(["--skip-git-repo-check", session_id, "-"]);
            } else {
                command.arg("exec");
                if stream {
                    command.arg("--json");
                }
                command.args(["--skip-git-repo-check", "-"]);
            }
        }
        ThreadProvider::Claude => {
            if stream {
                command.args(["-p", "--output-format", "stream-json"]);
                command.arg("--verbose");
                command.arg("--include-partial-messages");
            } else {
                command.args(["-p", "--output-format", "json"]);
            }
            if let Some(session_id) = resume_session_id {
                command.args(["--resume", session_id]);
            }
        }
    }
}

fn persist_thread_session_from_execution(
    workspace_root: &Path,
    provider: ThreadProvider,
    execution: &ProviderExecution,
    thread: &mut ThreadRecord,
) -> Result<(), String> {
    let Some(session_id) = execution.session_id.as_deref() else {
        return Ok(());
    };
    if session_id.trim().is_empty() {
        return Ok(());
    }

    let previous = thread
        .provider_sessions
        .insert(provider.id().to_string(), session_id.to_string());
    if previous.as_deref() != Some(session_id) {
        thread.updated_at = file_service::now_rfc3339()?;
        thread_service::save_thread_record(workspace_root, thread)?;
    }

    Ok(())
}

fn extract_session_id(provider: ThreadProvider, stdout: &str, stderr: &str) -> Option<String> {
    provider_parse::extract_session_id(provider_kind(provider), stdout, stderr)
}

fn configure_provider_environment(command: &mut Command, provider: ThreadProvider) {
    if let Some(path) = augmented_command_path() {
        command.env("PATH", path);
    }

    if provider == ThreadProvider::Claude {
        configure_claude_code_environment(command);
    }
}

fn augmented_command_path() -> Option<OsString> {
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();

    let mut add_path = |path: PathBuf| {
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    };

    if let Ok(home) = env::var("HOME") {
        let home_path = PathBuf::from(home);
        add_path(home_path.join(".local/bin"));
        add_path(home_path.join(".npm-global/bin"));
        add_path(home_path.join(".cargo/bin"));
    }

    for path in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        add_path(PathBuf::from(path));
    }

    env::join_paths(paths).ok()
}

fn configure_claude_code_environment(command: &mut Command) {
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDECODE",
    ] {
        command.env_remove(name);
    }

    if env::var("CLAUDE_CODE_OAUTH_TOKEN")
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false)
    {
        return;
    }

    if let Some(token) = claude_code_oauth_token_from_keychain() {
        command.env("CLAUDE_CODE_OAUTH_TOKEN", token);
    }
}

fn claude_code_oauth_token_from_keychain() -> Option<String> {
    let user = env::var("USER").unwrap_or_default();
    let mut command = Command::new("/usr/bin/security");
    command.args([
        "find-generic-password",
        "-a",
        user.as_str(),
        "-s",
        "claude-code-oauth-token",
        "-w",
    ]);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn resolve_provider_binary(provider: ThreadProvider) -> Result<PathBuf, String> {
    if let Ok(path) = env::var(provider.env_var()) {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if let Ok(output) = Command::new("which").arg(provider.binary_name()).output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
    }

    if let Ok(output) = Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {}", provider.binary_name())])
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
    }

    let mut candidates = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{}", provider.binary_name())),
        PathBuf::from(format!("/usr/local/bin/{}", provider.binary_name())),
    ];
    if let Ok(home) = env::var("HOME") {
        let home_path = PathBuf::from(home);
        candidates.push(home_path.join(format!(".local/bin/{}", provider.binary_name())));
        candidates.push(home_path.join(format!(".npm-global/bin/{}", provider.binary_name())));
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            format!(
                "{} is not available to Margent. Install {} or set {} to the {} binary path.",
                provider.display_name(),
                provider.display_name(),
                provider.env_var(),
                provider.binary_name()
            )
        })
}

fn parse_feedback_response(provider: ThreadProvider, raw: &str) -> Result<String, String> {
    provider_parse::parse_feedback_response(provider_kind(provider), raw)
}

struct FocusedRevisionResult {
    assistant_message: String,
    replacement_text: String,
    resolve_thread_ids: Vec<String>,
}

struct DocumentRevisionResult {
    assistant_message: String,
    updated_document_text: String,
    resolve_thread_ids: Vec<String>,
}

fn parse_focused_revision_response(
    provider: ThreadProvider,
    raw: &str,
) -> Result<FocusedRevisionResult, String> {
    let parsed = provider_parse::parse_focused_revision_response(provider_kind(provider), raw)?;

    Ok(FocusedRevisionResult {
        assistant_message: parsed.assistant_message,
        replacement_text: parsed.replacement_text,
        resolve_thread_ids: parsed.resolve_thread_ids,
    })
}

fn parse_document_revision_response(
    provider: ThreadProvider,
    raw: &str,
) -> Result<DocumentRevisionResult, String> {
    let parsed = provider_parse::parse_document_revision_response(provider_kind(provider), raw)?;

    Ok(DocumentRevisionResult {
        assistant_message: parsed.assistant_message,
        updated_document_text: parsed.updated_document_text,
        resolve_thread_ids: parsed.resolve_thread_ids,
    })
}

fn provider_response_text(provider: ThreadProvider, raw: &str) -> String {
    provider_parse::provider_response_text(provider_kind(provider), raw)
}

fn provider_stream_delta(provider: ThreadProvider, line: &str) -> Option<String> {
    provider_parse::provider_stream_delta(provider_kind(provider), line)
}

fn stream_delta_suffix(buffer: &mut String, candidate: &str) -> String {
    provider_parse::stream_delta_suffix(buffer, candidate)
}

#[cfg(test)]
fn extract_json_block(text: &str) -> String {
    provider_parse::extract_json_block(text)
}

fn extract_anchor_text(content: &str, anchor: &AnchorRecord) -> Result<String, String> {
    let start_byte = utf16_offset_to_byte_index(content, anchor.start_offset_utf16)?;
    let end_byte = utf16_offset_to_byte_index(content, anchor.end_offset_utf16)?;

    if start_byte > end_byte || end_byte > content.len() {
        return Err("Anchor offsets are out of bounds for the current document.".into());
    }

    Ok(content[start_byte..end_byte].to_string())
}

fn replace_anchor_text(
    content: &str,
    anchor: &AnchorRecord,
    replacement_text: &str,
) -> Result<String, String> {
    let start_byte = utf16_offset_to_byte_index(content, anchor.start_offset_utf16)?;
    let end_byte = utf16_offset_to_byte_index(content, anchor.end_offset_utf16)?;

    if start_byte > end_byte || end_byte > content.len() {
        return Err("Anchor offsets are out of bounds for the current document.".into());
    }

    let mut updated = String::new();
    updated.push_str(&content[..start_byte]);
    updated.push_str(replacement_text);
    updated.push_str(&content[end_byte..]);
    Ok(updated)
}

fn utf16_offset_to_byte_index(content: &str, utf16_offset: usize) -> Result<usize, String> {
    let mut current_utf16 = 0usize;

    for (byte_index, character) in content.char_indices() {
        if current_utf16 == utf16_offset {
            return Ok(byte_index);
        }

        current_utf16 += character.len_utf16();
        if current_utf16 > utf16_offset {
            return Err(format!(
                "UTF-16 offset {utf16_offset} lands inside a character boundary."
            ));
        }
    }

    if current_utf16 == utf16_offset {
        Ok(content.len())
    } else {
        Err(format!(
            "UTF-16 offset {utf16_offset} is beyond the document length."
        ))
    }
}

fn write_revision_proposal(
    provider: ThreadProvider,
    workspace_root: &Path,
    thread: &mut ThreadRecord,
    document: &DocumentRecord,
    document_content: &str,
    revision: &FocusedRevisionResult,
    updated_document_text: String,
) -> Result<ProposalRecord, String> {
    write_provider_revision_proposal(
        provider,
        workspace_root,
        thread,
        document,
        document_content,
        &revision.assistant_message,
        &revision.resolve_thread_ids,
        updated_document_text,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_provider_revision_proposal(
    provider: ThreadProvider,
    workspace_root: &Path,
    thread: &mut ThreadRecord,
    document: &DocumentRecord,
    document_content: &str,
    assistant_message: &str,
    resolve_thread_ids: &[String],
    updated_document_text: String,
) -> Result<ProposalRecord, String> {
    let now = file_service::now_rfc3339()?;
    let proposal_id = thread_service::next_id("proposal")?;
    let computed_diff =
        diff_service::compute_unified_diff(document_content, &updated_document_text);

    thread_service::append_event(
        workspace_root,
        "proposal.requested",
        Some(&thread.id),
        Some(&document.id),
        Some(&proposal_id),
        None,
    )?;

    let proposal = ProposalRecord {
        schema_version: 1,
        id: proposal_id,
        document_id: document.id.clone(),
        thread_ids: vec![thread.id.clone()],
        adapter_id: provider.id().into(),
        created_at: now.clone(),
        updated_at: now.clone(),
        status: "pending".into(),
        base_content_hash: document.current_content_hash.clone(),
        response_mode: "updated_document".into(),
        summary: summarize_proposal(provider, assistant_message),
        assistant_message: assistant_message.to_string(),
        updated_document_text: Some(updated_document_text),
        unified_diff: None,
        computed_diff,
        warnings: Vec::new(),
        resolve_thread_ids: resolve_thread_ids.to_vec(),
        stderr: None,
        error_message: None,
        extra: Default::default(),
    };

    save_proposal_record(workspace_root, &proposal)?;

    if !thread
        .linked_proposal_ids
        .iter()
        .any(|proposal_id| proposal_id == &proposal.id)
    {
        thread.linked_proposal_ids.push(proposal.id.clone());
        thread.updated_at = now;
        thread_service::save_thread_record(workspace_root, thread)?;
    }

    thread_service::append_event(
        workspace_root,
        "proposal.received",
        Some(&thread.id),
        Some(&document.id),
        Some(&proposal.id),
        None,
    )?;

    Ok(proposal)
}

fn save_proposal_record(workspace_root: &Path, proposal: &ProposalRecord) -> Result<(), String> {
    let mdreview_path = file_service::ensure_workspace_layout(workspace_root)?;
    let proposal_path = mdreview_path
        .join("proposals")
        .join(format!("{}.json", proposal.id));
    file_service::write_json_atomic(&proposal_path, proposal)
}

fn summarize_proposal(provider: ThreadProvider, assistant_message: &str) -> String {
    let normalized = assistant_message.replace('\n', " ").trim().to_string();

    if normalized.is_empty() {
        return format!("Proposal from {}", provider.display_name());
    }

    let mut chars = normalized.chars();
    let summary = chars.by_ref().take(93).collect::<String>();
    if chars.next().is_some() {
        format!("{summary}...")
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::models::provider::{ProviderDocumentAction, ProviderThreadAction, ThreadProvider};
    use crate::models::thread::AnchorRecord;
    use crate::services::{file_service, provider_service, thread_service, workspace_service};

    use super::{
        extract_json_block, extract_session_id, parse_focused_revision_response,
        provider_response_text,
    };

    static PROVIDER_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn extracts_json_from_fenced_provider_response() {
        let raw = "Done.\n```json\n{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[\"thread_1\"]}\n```";
        let parsed =
            parse_focused_revision_response(ThreadProvider::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
        assert_eq!(parsed.resolve_thread_ids, vec!["thread_1"]);
    }

    #[test]
    fn extracts_embedded_json_object_from_provider_response() {
        let raw = "Here is the JSON:\n{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}\nDone.";
        let parsed =
            parse_focused_revision_response(ThreadProvider::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
        assert!(parsed.resolve_thread_ids.is_empty());
    }

    #[test]
    fn handles_trailing_prose_after_json_object() {
        let raw = "{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}\n\nThat should improve clarity.";
        let parsed =
            parse_focused_revision_response(ThreadProvider::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
    }

    #[test]
    fn skips_non_matching_embedded_braces() {
        // Codex may emit prose that mentions `{template}` placeholders
        // before producing the real JSON object. The scanner must keep
        // going until it finds an object that contains `replacementText`.
        let raw = "Use the `{name}` syntax. Then respond like:\n{\"foo\":42}\nFinally, here is the response:\n{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}\n";
        let parsed =
            parse_focused_revision_response(ThreadProvider::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
    }

    #[test]
    fn handles_concatenated_agent_messages_around_json() {
        // The streaming reader concatenates multiple `agent_message`
        // events with no separator, which produced inputs like
        // "Done.{...}" that used to fail with "expected value at line
        // 1 column 1".
        let raw = "Done.{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}";
        let parsed =
            parse_focused_revision_response(ThreadProvider::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
    }

    #[test]
    fn document_revision_handles_prose_around_json() {
        use super::parse_document_revision_response;
        let raw = "Here is the revised document:\n{\"assistantMessage\":\"Rewrote intro\",\"updatedDocumentText\":\"# New title\\nBody.\\n\",\"resolveThreadIds\":[]}\nDone.";
        let parsed =
            parse_document_revision_response(ThreadProvider::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Rewrote intro");
        assert_eq!(parsed.updated_document_text, "# New title\nBody.\n");
    }

    #[test]
    fn focused_revision_accepts_plain_replacement_text() {
        let raw = "Revised passage:\nThis paragraph is clearer and more direct.";
        let parsed =
            parse_focused_revision_response(ThreadProvider::Codex, raw).expect("parse response");

        assert_eq!(
            parsed.assistant_message,
            "Proposed a replacement for the selected passage."
        );
        assert_eq!(
            parsed.replacement_text,
            "This paragraph is clearer and more direct."
        );
        assert!(parsed.resolve_thread_ids.is_empty());
    }

    #[test]
    fn json_block_falls_back_to_trimmed_text() {
        assert_eq!(extract_json_block("{\"ok\":true}\n"), "{\"ok\":true}");
    }

    #[test]
    fn provider_response_text_prefers_stream_result() {
        let raw = "{\"type\":\"message_delta\",\"delta\":\"Partial\"}\n{\"session_id\":\"session-1\",\"result\":\"Final desktop answer\"}\n";

        assert_eq!(
            provider_response_text(ThreadProvider::Codex, raw),
            "Final desktop answer"
        );
    }

    #[test]
    fn provider_response_text_reads_codex_agent_message_events() {
        let raw = "{\"type\":\"thread.started\",\"thread_id\":\"thread-current\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"web_search\",\"text\":\"ignored\"}}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Actual desktop answer\"}}\n";

        assert_eq!(
            provider_response_text(ThreadProvider::Codex, raw),
            "Actual desktop answer"
        );
    }

    #[test]
    fn extract_session_id_reads_codex_thread_id() {
        let raw = "{\"type\":\"thread.started\",\"thread_id\":\"019ec99e-c42a\"}\n";

        assert_eq!(
            extract_session_id(ThreadProvider::Codex, raw, ""),
            Some("019ec99e-c42a".into())
        );
    }

    #[test]
    fn codex_feedback_action_persists_agent_reply() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-codex-feedback");
        let codex_bin = write_fake_codex(&workspace_root);
        let (_doc_id, thread_id) = create_review_workspace(&workspace_root);
        let previous_codex_bin = env::var_os("CODEX_BIN");
        env::set_var("CODEX_BIN", &codex_bin);

        let result = provider_service::run_provider_thread_action(
            workspace_root.to_str().expect("workspace root"),
            &_doc_id,
            &thread_id,
            ThreadProvider::Codex,
            ProviderThreadAction::Feedback,
            "",
            None,
        )
        .expect("run feedback action");

        restore_codex_bin(previous_codex_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        let message = result.thread.messages.last().expect("codex reply");
        assert_eq!(message.author_type, "agent");
        assert_eq!(message.agent_id.as_deref(), Some("codex"));
        assert_eq!(message.body, "Codex feedback text");
        assert!(result.proposal.is_none());
    }

    #[test]
    fn codex_stream_action_emits_deltas_and_persists_final_reply() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-codex-stream");
        let codex_bin = write_fake_streaming_codex(&workspace_root);
        let (doc_id, thread_id) = create_review_workspace(&workspace_root);
        let previous_codex_bin = env::var_os("CODEX_BIN");
        env::set_var("CODEX_BIN", &codex_bin);

        let registry = provider_service::ProviderRunRegistry::default();
        let mut events = Vec::new();
        let result = provider_service::run_provider_thread_action_with_stream(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            None,
            &thread_id,
            ThreadProvider::Codex,
            ProviderThreadAction::Feedback,
            "",
            None,
            Some(provider_service::ProviderRunContext {
                run_id: "run-test".into(),
                workspace_root: workspace_root.to_string_lossy().to_string(),
                thread_id: Some(thread_id.clone()),
            }),
            Some(&registry),
            &mut |event| events.push(event),
        )
        .expect("run streaming feedback action");

        restore_codex_bin(previous_codex_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        let message = result.thread.messages.last().expect("codex reply");
        assert_eq!(message.body, "Final streamed feedback");
        assert_eq!(
            result
                .thread
                .provider_sessions
                .get("codex")
                .map(String::as_str),
            Some("session-tauri-stream")
        );
        assert_eq!(
            events
                .iter()
                .filter_map(|event| event.text.as_deref())
                .collect::<Vec<_>>(),
            vec!["Live ", "feedback"]
        );
        assert!(events.iter().all(|event| event.run_id == "run-test"));
    }

    #[test]
    fn provider_action_uses_relative_path_when_invocation_document_id_is_stale() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-stale-invocation-doc");
        let codex_bin = write_fake_codex(&workspace_root);
        let (doc_id, thread_id) = create_review_workspace(&workspace_root);
        let previous_codex_bin = env::var_os("CODEX_BIN");
        env::set_var("CODEX_BIN", &codex_bin);

        let result = provider_service::run_provider_thread_action_with_stream(
            workspace_root.to_str().expect("workspace root"),
            "doc_missing_from_registry",
            Some("draft.md"),
            &thread_id,
            ThreadProvider::Codex,
            ProviderThreadAction::Feedback,
            "",
            None,
            None,
            None,
            &mut |_| {},
        )
        .expect("run feedback with stale invocation document id");

        restore_codex_bin(previous_codex_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        assert_eq!(result.thread.document_id, doc_id);
        let message = result.thread.messages.last().expect("codex reply");
        assert_eq!(message.body, "Codex feedback text");
    }

    #[test]
    fn provider_action_retargets_stale_thread_document_id_when_anchor_matches() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-stale-thread-doc");
        let codex_bin = write_fake_codex(&workspace_root);
        let (doc_id, thread_id) = create_review_workspace(&workspace_root);
        let mut thread =
            thread_service::load_thread_record(&workspace_root, &thread_id).expect("load thread");
        thread.document_id = "doc_missing_from_registry".into();
        thread_service::save_thread_record(&workspace_root, &thread).expect("save stale thread");
        let previous_codex_bin = env::var_os("CODEX_BIN");
        env::set_var("CODEX_BIN", &codex_bin);

        let result = provider_service::run_provider_thread_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            &thread_id,
            ThreadProvider::Codex,
            ProviderThreadAction::Feedback,
            "",
            None,
        )
        .expect("run feedback with stale thread document id");
        let saved_thread = thread_service::load_thread_record(&workspace_root, &thread_id)
            .expect("load repaired thread");

        restore_codex_bin(previous_codex_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        assert_eq!(result.thread.document_id, doc_id);
        assert_eq!(saved_thread.document_id, doc_id);
        let message = result.thread.messages.last().expect("codex reply");
        assert_eq!(message.body, "Codex feedback text");
    }

    #[test]
    fn codex_revise_action_persists_pending_proposal() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-codex-revise");
        let codex_bin = write_fake_codex(&workspace_root);
        let (doc_id, thread_id) = create_review_workspace(&workspace_root);
        let previous_codex_bin = env::var_os("CODEX_BIN");
        env::set_var("CODEX_BIN", &codex_bin);

        let result = provider_service::run_provider_thread_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            &thread_id,
            ThreadProvider::Codex,
            ProviderThreadAction::Revise,
            "",
            None,
        )
        .expect("run revise action");

        restore_codex_bin(previous_codex_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        let proposal = result.proposal.expect("proposal");
        assert_eq!(proposal.status, "pending");
        assert_eq!(proposal.adapter_id, "codex");
        assert_eq!(
            proposal.updated_document_text.as_deref(),
            Some("This sentence is clearer.\n")
        );
        assert!(result.thread.linked_proposal_ids.contains(&proposal.id));
    }

    #[test]
    fn claude_feedback_action_persists_agent_reply() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-claude-feedback");
        let claude_bin = write_fake_claude(&workspace_root);
        let (doc_id, thread_id) = create_review_workspace(&workspace_root);
        let previous_claude_bin = env::var_os("CLAUDE_BIN");
        env::set_var("CLAUDE_BIN", &claude_bin);

        let result = provider_service::run_provider_thread_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            &thread_id,
            ThreadProvider::Claude,
            ProviderThreadAction::Feedback,
            "",
            None,
        )
        .expect("run feedback action");

        restore_env_var("CLAUDE_BIN", previous_claude_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        let message = result.thread.messages.last().expect("claude reply");
        assert_eq!(message.author_type, "agent");
        assert_eq!(message.agent_id.as_deref(), Some("claude"));
        assert_eq!(message.author_name, "Claude Code");
        assert_eq!(message.body, "Claude feedback text");
        assert_eq!(
            result
                .thread
                .provider_sessions
                .get("claude")
                .map(String::as_str),
            Some("session-claude-test")
        );
        assert!(result.proposal.is_none());
    }

    #[test]
    fn claude_revise_action_persists_pending_proposal() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-claude-revise");
        let claude_bin = write_fake_claude(&workspace_root);
        let (doc_id, thread_id) = create_review_workspace(&workspace_root);
        let previous_claude_bin = env::var_os("CLAUDE_BIN");
        env::set_var("CLAUDE_BIN", &claude_bin);

        let result = provider_service::run_provider_thread_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            &thread_id,
            ThreadProvider::Claude,
            ProviderThreadAction::Revise,
            "",
            None,
        )
        .expect("run revise action");

        restore_env_var("CLAUDE_BIN", previous_claude_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        let proposal = result.proposal.expect("proposal");
        assert_eq!(proposal.status, "pending");
        assert_eq!(proposal.adapter_id, "claude");
        assert_eq!(
            proposal.updated_document_text.as_deref(),
            Some("This sentence is clearer from Claude.\n")
        );
        assert_eq!(
            result
                .thread
                .provider_sessions
                .get("claude")
                .map(String::as_str),
            Some("session-claude-test")
        );
        assert!(result.thread.linked_proposal_ids.contains(&proposal.id));
    }

    #[test]
    fn codex_document_feedback_creates_document_thread() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-codex-document-feedback");
        let codex_bin = write_fake_codex(&workspace_root);
        let (doc_id, _thread_id) = create_review_workspace(&workspace_root);
        let previous_codex_bin = env::var_os("CODEX_BIN");
        env::set_var("CODEX_BIN", &codex_bin);

        let result = provider_service::run_provider_document_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            ThreadProvider::Codex,
            ProviderDocumentAction::Feedback,
            "Give me a style pass.",
            None,
        )
        .expect("run document feedback");

        restore_codex_bin(previous_codex_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        assert!(result.thread.tags.contains(&"document".to_string()));
        assert_eq!(result.thread.anchor.kind, "document");
        assert_eq!(result.thread.messages[0].body, "Give me a style pass.");
        let message = result.thread.messages.last().expect("codex reply");
        assert_eq!(message.agent_id.as_deref(), Some("codex"));
        assert_eq!(message.body, "Codex feedback text");
        assert!(result.proposal.is_none());
    }

    #[test]
    fn claude_document_revise_creates_document_proposal() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-claude-document-revise");
        let claude_bin = write_fake_claude(&workspace_root);
        let (doc_id, _thread_id) = create_review_workspace(&workspace_root);
        let previous_claude_bin = env::var_os("CLAUDE_BIN");
        env::set_var("CLAUDE_BIN", &claude_bin);

        let result = provider_service::run_provider_document_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            ThreadProvider::Claude,
            ProviderDocumentAction::Revise,
            "Fix grammar across the document.",
            None,
        )
        .expect("run document revise");

        restore_env_var("CLAUDE_BIN", previous_claude_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        assert!(result.thread.tags.contains(&"document".to_string()));
        assert_eq!(result.thread.anchor.kind, "document");
        let proposal = result.proposal.expect("proposal");
        assert_eq!(proposal.adapter_id, "claude");
        assert_eq!(
            proposal.updated_document_text.as_deref(),
            Some("This whole document is clearer from Claude.\n")
        );
        assert!(result.thread.linked_proposal_ids.contains(&proposal.id));
    }

    #[test]
    fn document_thread_revise_routes_to_whole_document_proposal() {
        let _lock = PROVIDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let workspace_root = unique_temp_dir("margent-document-thread-revise");
        let codex_bin = write_fake_codex(&workspace_root);
        let (doc_id, _thread_id) = create_review_workspace(&workspace_root);
        let previous_codex_bin = env::var_os("CODEX_BIN");
        env::set_var("CODEX_BIN", &codex_bin);

        let feedback_result = provider_service::run_provider_document_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            ThreadProvider::Codex,
            ProviderDocumentAction::Feedback,
            "check for grammar errors",
            None,
        )
        .expect("run document feedback");
        let mut document_thread = feedback_result.thread;
        document_thread.anchor.state = "detached".into();
        thread_service::save_thread_record(&workspace_root, &document_thread)
            .expect("save detached document thread");

        let result = provider_service::run_provider_thread_action(
            workspace_root.to_str().expect("workspace root"),
            &doc_id,
            &document_thread.id,
            ThreadProvider::Codex,
            ProviderThreadAction::Revise,
            "",
            None,
        )
        .expect("run document-thread revise");

        restore_codex_bin(previous_codex_bin);
        fs::remove_dir_all(&workspace_root).expect("cleanup");

        assert_eq!(result.thread.anchor.kind, "document");
        assert_eq!(result.thread.anchor.state, "attached");
        let proposal = result.proposal.expect("proposal");
        assert_eq!(proposal.adapter_id, "codex");
        assert_eq!(
            proposal.updated_document_text.as_deref(),
            Some("This whole document is clearer from Codex.")
        );
        assert!(result.thread.linked_proposal_ids.contains(&proposal.id));
    }

    fn create_review_workspace(workspace_root: &Path) -> (String, String) {
        fs::create_dir_all(workspace_root).expect("create workspace");
        let content = "This sentence needs work.\n";
        fs::write(workspace_root.join("draft.md"), content).expect("write draft");
        let snapshot =
            workspace_service::open_workspace(workspace_root.to_str().expect("root str"))
                .expect("open workspace");
        let document = snapshot.documents.first().expect("document");
        let quote = "This sentence needs work.";
        let start = content.find(quote).expect("quote start");
        let end = start + quote.encode_utf16().count();
        let anchor = AnchorRecord {
            quote: quote.into(),
            prefix_context: String::new(),
            suffix_context: "\n".into(),
            start_offset_utf16: start,
            end_offset_utf16: end,
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: end + 1,
            heading_path: Vec::new(),
            block_fingerprint: String::new(),
            base_content_hash: file_service::content_hash(content),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        };
        let thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &document.id,
            "Tighten sentence",
            "Please tighten this sentence.",
            anchor,
        )
        .expect("create thread");

        (document.id.clone(), thread.id)
    }

    fn write_fake_codex(workspace_root: &Path) -> PathBuf {
        fs::create_dir_all(workspace_root).expect("create fake codex parent");
        let script_path = workspace_root.join("fake-codex.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\nprompt=$(cat)\ncase \"$prompt\" in\n  *updatedDocumentText*) printf '%s\\n' '{\"assistantMessage\":\"Codex revised document\",\"updatedDocumentText\":\"This whole document is clearer from Codex.\",\"resolveThreadIds\":[]}' ;;\n  *replacementText*) printf '%s\\n' '{\"assistantMessage\":\"Tightened sentence\",\"replacementText\":\"This sentence is clearer.\",\"resolveThreadIds\":[]}' ;;\n  *) printf '%s\\n' 'Codex feedback text' ;;\nesac\n",
        )
        .expect("write fake codex");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&script_path)
                .expect("fake codex metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&script_path, permissions).expect("chmod fake codex");
        }

        script_path
    }

    fn write_fake_streaming_codex(workspace_root: &Path) -> PathBuf {
        fs::create_dir_all(workspace_root).expect("create fake streaming codex parent");
        let script_path = workspace_root.join("fake-streaming-codex.sh");
        fs::write(
            &script_path,
            r#"#!/bin/sh
cat >/dev/null
printf '{"type":"message_delta","delta":"Live "}\n'
printf '{"type":"message_delta","delta":"Live feedback"}\n'
printf '{"session_id":"session-tauri-stream","result":"Final streamed feedback"}\n'
"#,
        )
        .expect("write fake streaming codex");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&script_path)
                .expect("fake streaming codex metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&script_path, permissions).expect("chmod fake streaming codex");
        }

        script_path
    }

    fn write_fake_claude(workspace_root: &Path) -> PathBuf {
        fs::create_dir_all(workspace_root).expect("create fake claude parent");
        let script_path = workspace_root.join("fake-claude.sh");
        fs::write(
            &script_path,
            r#"#!/bin/sh
prompt=$(cat)
case "$prompt" in
  *updatedDocumentText*) cat <<'JSON'
{"session_id":"session-claude-test","result":"{\"assistantMessage\":\"Claude revised document\",\"updatedDocumentText\":\"This whole document is clearer from Claude.\\n\",\"resolveThreadIds\":[]}"}
JSON
    ;;
  *replacementText*) cat <<'JSON'
{"session_id":"session-claude-test","result":"{\"assistantMessage\":\"Claude tightened sentence\",\"replacementText\":\"This sentence is clearer from Claude.\",\"resolveThreadIds\":[]}"}
JSON
    ;;
  *) cat <<'JSON'
{"session_id":"session-claude-test","result":"Claude feedback text"}
JSON
    ;;
esac
"#,
        )
        .expect("write fake claude");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&script_path)
                .expect("fake claude metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&script_path, permissions).expect("chmod fake claude");
        }

        script_path
    }

    fn restore_codex_bin(previous_codex_bin: Option<std::ffi::OsString>) {
        restore_env_var("CODEX_BIN", previous_codex_bin);
    }

    fn restore_env_var(name: &str, previous_value: Option<std::ffi::OsString>) {
        if let Some(value) = previous_value {
            env::set_var(name, value);
        } else {
            env::remove_var(name);
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        env::temp_dir().join(format!("{prefix}-{nonce}"))
    }
}
