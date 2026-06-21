use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::models::*;
use margent_core::provider_parse;
use margent_core::provider_readiness::ProviderKind;
use serde::{Deserialize, Serialize};
use wait_timeout::ChildExt;

const PROVIDER_TIMEOUT_SECONDS: u64 = 600;

// ── Provider enum ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Provider {
    Codex,
    Claude,
}

impl Provider {
    pub fn id(&self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Claude => "claude",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Provider::Codex => "Codex",
            Provider::Claude => "Claude Code",
        }
    }

    pub fn binary(&self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Claude => "claude",
        }
    }

    /// Check if the provider binary is on PATH.
    pub fn is_available(&self) -> bool {
        Command::new("which")
            .arg(self.binary())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

fn provider_kind(provider: Provider) -> ProviderKind {
    match provider {
        Provider::Codex => ProviderKind::Codex,
        Provider::Claude => ProviderKind::Claude,
    }
}

// ── Prompt construction ─────────────────────────────────────────────────────

pub fn build_feedback_prompt(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
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

    prompt.push_str("## Review Thread\n\n");
    prompt.push_str(&format!("**Thread ID:** {}\n", thread.id));
    prompt.push_str(&format!("**Title:** {}\n", thread.title));
    prompt.push_str(&format!("**Status:** {}\n", thread.status));
    prompt.push_str(&format!(
        "**Anchor quote:** \"{}\"\n\n",
        thread.anchor.quote
    ));

    prompt.push_str("### Conversation\n\n");
    for msg in &thread.messages {
        let role = match msg.author_type.as_str() {
            "agent" => format!("[{}]", msg.author_name),
            "system" => "[system]".to_string(),
            _ => format!("[{}]", msg.author_name),
        };
        prompt.push_str(&format!("{role}: {}\n\n", msg.body));
    }

    prompt.push_str("## Your Task\n\n");
    prompt.push_str(
        "Provide constructive feedback on the highlighted passage in the context of this review thread. \
         Consider the conversation so far and offer a thoughtful reply that helps improve the writing. \
         Respond with ONLY your feedback text — no JSON wrapping, no markdown code fences around your entire response.\n",
    );

    prompt
}

pub fn build_feedback_prompt_with_instruction(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
    instruction: &str,
) -> String {
    let base = build_feedback_prompt(document_content, document_path, thread);
    format!("{base}\n## Additional Instructions\n\n{instruction}\n")
}

pub fn build_sync_action_prompt(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
    agent_id: &str,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("You are an agent participant in Margent, a local Markdown review tool.\n\n");
    prompt.push_str("You are running as agent id `");
    prompt.push_str(agent_id);
    prompt.push_str("`. Review the active document and the triggering thread, then return a structured action envelope.\n\n");

    prompt.push_str("## Document\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n\n"));
    prompt.push_str("```markdown\n");
    prompt.push_str(document_content);
    if !document_content.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");

    prompt.push_str("## Triggering Review Thread\n\n");
    prompt.push_str(&format!("**Thread ID:** {}\n", thread.id));
    prompt.push_str(&format!("**Title:** {}\n", thread.title));
    prompt.push_str(&format!("**Status:** {}\n", thread.status));
    prompt.push_str(&format!(
        "**Anchor quote:** \"{}\"\n\n",
        thread.anchor.quote
    ));

    prompt.push_str("### Conversation\n\n");
    for msg in &thread.messages {
        let role = match msg.author_type.as_str() {
            "agent" => format!("[{}]", msg.author_name),
            "system" => "[system]".to_string(),
            _ => format!("[{}]", msg.author_name),
        };
        prompt.push_str(&format!("{role}: {}\n\n", msg.body));
    }

    prompt.push_str("## Response Contract\n\n");
    prompt.push_str(
        "Return ONLY valid JSON. Do not wrap it in prose. Use this exact action-envelope shape:\n\n\
         {\n\
           \"status\": \"ok\",\n\
           \"actions\": [\n\
             {\n\
               \"type\": \"reply_to_thread\",\n\
               \"threadId\": \"thread id\",\n\
               \"replyToMessageId\": null,\n\
               \"body\": \"short, useful reply\"\n\
             },\n\
             {\n\
               \"type\": \"propose_revision\",\n\
               \"threadId\": \"thread id\",\n\
               \"assistantMessage\": \"what changed and why\",\n\
               \"responseMode\": \"updated_document\",\n\
               \"updatedDocumentText\": \"the complete revised document text\",\n\
               \"resolveThreadIds\": []\n\
             },\n\
             {\n\
               \"type\": \"add_thread\",\n\
               \"quote\": \"exact quote from the document\",\n\
               \"quoteOccurrence\": 1,\n\
               \"title\": \"optional title\",\n\
               \"body\": \"new review comment\"\n\
             },\n\
             { \"type\": \"noop\", \"reason\": \"nothing useful to add\" }\n\
           ],\n\
           \"warnings\": []\n\
         }\n\n",
    );
    prompt.push_str(
        "Guidelines:\n\
         - Prefer one precise reply_to_thread when the thread only needs feedback.\n\
         - Use propose_revision only when you can return the complete updated document text.\n\
         - Use add_thread only for a new issue grounded in an exact quote from the current document.\n\
         - Use noop if the latest message is already resolved or does not need an agent response.\n",
    );

    prompt
}

pub fn build_revise_prompt(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
) -> String {
    let mut prompt = String::new();
    prompt
        .push_str("You are a writing revision assistant for Margent, a Markdown review tool.\n\n");
    prompt.push_str("## Document\n\n");
    prompt.push_str(&format!("**File:** {document_path}\n\n"));
    prompt.push_str("```markdown\n");
    prompt.push_str(document_content);
    if !document_content.ends_with('\n') {
        prompt.push('\n');
    }
    prompt.push_str("```\n\n");

    prompt.push_str("## Review Thread\n\n");
    prompt.push_str(&format!("**Thread ID:** {}\n", thread.id));
    prompt.push_str(&format!("**Title:** {}\n", thread.title));
    prompt.push_str(&format!("**Status:** {}\n", thread.status));
    prompt.push_str(&format!(
        "**Anchor quote:** \"{}\"\n\n",
        thread.anchor.quote
    ));

    prompt.push_str("### Conversation\n\n");
    for msg in &thread.messages {
        let role = match msg.author_type.as_str() {
            "agent" => format!("[{}]", msg.author_name),
            "system" => "[system]".to_string(),
            _ => format!("[{}]", msg.author_name),
        };
        prompt.push_str(&format!("{role}: {}\n\n", msg.body));
    }

    prompt.push_str("## Your Task\n\n");
    prompt.push_str(
        "Based on the review thread, revise the document to address the feedback. \
         You MUST respond with a JSON object in this exact format:\n\n\
         ```json\n\
         {\n\
           \"assistantMessage\": \"Brief description of what you changed\",\n\
           \"updatedDocumentText\": \"The complete revised document text\",\n\
           \"resolveThreadIds\": [\"Optional thread ids to resolve after the edit is applied\"]\n\
         }\n\
         ```\n\n\
         Important:\n\
         - Return the ENTIRE document text in updatedDocumentText, not just the changed portion\n\
         - resolveThreadIds is optional; omit it or return an empty array if no thread should be resolved\n\
         - Only modify what is necessary to address the thread\n\
         - Preserve all formatting, whitespace, and content not related to the feedback\n\
         - The response MUST be valid JSON\n",
    );

    prompt
}

pub fn build_revise_prompt_with_instruction(
    document_content: &str,
    document_path: &str,
    thread: &ThreadRecord,
    instruction: &str,
) -> String {
    let base = build_revise_prompt(document_content, document_path, thread);
    format!("{base}\n## Additional Instructions\n\n{instruction}\n")
}

pub fn build_focused_revise_prompt(
    document_path: &str,
    thread: &ThreadRecord,
    target_text: &str,
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

    prompt.push_str("## Review Thread\n\n");
    prompt.push_str(&format!("**Thread ID:** {}\n", thread.id));
    prompt.push_str(&format!("**Title:** {}\n", thread.title));
    prompt.push_str(&format!("**Status:** {}\n", thread.status));
    prompt.push_str(&format!(
        "**Anchor quote:** \"{}\"\n\n",
        thread.anchor.quote
    ));

    prompt.push_str("### Conversation\n\n");
    for msg in &thread.messages {
        let role = match msg.author_type.as_str() {
            "agent" => format!("[{}]", msg.author_name),
            "system" => "[system]".to_string(),
            _ => format!("[{}]", msg.author_name),
        };
        prompt.push_str(&format!("{role}: {}\n\n", msg.body));
    }

    prompt.push_str("## Your Task\n\n");
    prompt.push_str(
        "Revise ONLY the target passage above to address the feedback. \
         You MUST respond with ONLY a valid JSON object in this exact shape, with no Markdown fence and no prose before or after it:\n\n\
         {\"assistantMessage\":\"Brief description of what you changed\",\"replacementText\":\"The revised text that should replace the target passage\",\"resolveThreadIds\":[]}\n\n\
         Important:\n\
         - Return ONLY the replacement passage in replacementText, not the full document\n\
         - The replacement text will be spliced back into the original document at the anchored range\n\
         - You may make the replacement shorter or longer if needed\n\
         - Preserve markdown formatting and the surrounding voice of the document\n\
         - resolveThreadIds is optional; omit it or return an empty array if no thread should be resolved\n\
         - The response MUST be valid JSON\n",
    );

    prompt
}

pub fn build_focused_revise_prompt_with_instruction(
    document_path: &str,
    thread: &ThreadRecord,
    target_text: &str,
    instruction: &str,
) -> String {
    let base = build_focused_revise_prompt(document_path, thread, target_text);
    format!("{base}\n## Additional Instructions\n\n{instruction}\n")
}

pub fn build_codify_prompt(existing_memory: Option<&str>, outcomes: &[String]) -> String {
    let mut prompt = String::new();
    prompt.push_str(
        "You maintain `.mdreview/memory.md` for Margent, a local Markdown review workspace.\n\n",
    );
    prompt.push_str(
        "Distill durable review lessons from recently resolved threads and proposal decisions. \
         The memory file is human-editable standing context for future provider actions, so it should be concise, concrete, and useful.\n\n",
    );

    prompt.push_str("## Existing Memory\n\n");
    match existing_memory
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(memory) => {
            prompt.push_str("```markdown\n");
            prompt.push_str(memory);
            if !memory.ends_with('\n') {
                prompt.push('\n');
            }
            prompt.push_str("```\n\n");
        }
        None => {
            prompt.push_str("No prior review memory exists.\n\n");
        }
    }

    prompt.push_str("## New Review Outcomes\n\n");
    for (index, outcome) in outcomes.iter().enumerate() {
        prompt.push_str(&format!("### Outcome {}\n\n", index + 1));
        prompt.push_str(outcome.trim());
        prompt.push_str("\n\n");
    }

    prompt.push_str("## Response Contract\n\n");
    prompt.push_str(
        "Return ONLY the complete Markdown contents for `.mdreview/memory.md`. \
         Do not wrap it in a code fence and do not include commentary before or after it.\n\n\
         Guidelines:\n\
         - Preserve useful existing memory unless the new outcomes clearly supersede it.\n\
         - Capture recurring preferences, accepted revision patterns, rejected approaches, factual constraints, and voice guidance.\n\
         - Omit one-off transcript details, private chain-of-thought, and raw event IDs unless they are genuinely useful.\n\
         - Keep the result short enough to prepend to future prompts.\n",
    );

    prompt
}

// ── Provider execution ──────────────────────────────────────────────────────

pub struct ProviderResponse {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub session_id: Option<String>,
}

#[derive(Default)]
pub struct ProviderExecutionOptions {
    pub resume_session_id: Option<String>,
    pub stream: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStreamEvent {
    pub event: &'static str,
    pub provider: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

pub fn execute_provider_for_thread(
    provider: Provider,
    prompt: &str,
    thread: &ThreadRecord,
) -> Result<ProviderResponse, String> {
    execute_provider_with_options(
        provider,
        prompt,
        ProviderExecutionOptions {
            resume_session_id: thread.provider_sessions.get(provider.id()).cloned(),
            stream: false,
        },
    )
}

pub fn persist_thread_session_from_response(
    provider: Provider,
    response: &ProviderResponse,
    thread: &mut ThreadRecord,
) -> bool {
    let Some(session_id) = response.session_id.as_deref() else {
        return false;
    };

    if session_id.trim().is_empty() {
        return false;
    }

    let previous = thread
        .provider_sessions
        .insert(provider.id().to_string(), session_id.to_string());
    previous.as_deref() != Some(session_id)
}

pub fn execute_provider_with_options(
    provider: Provider,
    prompt: &str,
    options: ProviderExecutionOptions,
) -> Result<ProviderResponse, String> {
    execute_provider_with_options_and_stream(provider, prompt, options, |_| {})
}

pub fn execute_provider_with_options_and_stream<F>(
    provider: Provider,
    prompt: &str,
    options: ProviderExecutionOptions,
    mut on_event: F,
) -> Result<ProviderResponse, String>
where
    F: FnMut(ProviderStreamEvent),
{
    let mut command = Command::new(provider.binary());
    configure_provider_environment(&mut command, provider);
    configure_provider_command(&mut command, provider, &options);

    if options.stream {
        execute_provider_streaming(provider, command, prompt, &mut on_event)
    } else {
        execute_provider_buffered(provider, command, prompt)
    }
}

fn execute_provider_buffered(
    provider: Provider,
    mut command: Command,
    prompt: &str,
) -> Result<ProviderResponse, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute {}: {e}", provider.binary()))?;

    {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            format!(
                "Failed to open {} stdin for prompt delivery.",
                provider.display_name()
            )
        })?;
        stdin.write_all(prompt.as_bytes()).map_err(|e| {
            let _ = child.kill();
            format!(
                "Failed to write prompt to {} stdin: {e}",
                provider.display_name()
            )
        })?;
    }

    let timed_out = child
        .wait_timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECONDS))
        .map_err(|e| format!("Failed to wait for {}: {e}", provider.display_name()))?
        .is_none();

    if timed_out {
        let _ = child.kill();
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read {} output: {e}", provider.display_name()))?;

    if timed_out {
        return Err(format!(
            "{} timed out after {PROVIDER_TIMEOUT_SECONDS} seconds.",
            provider.display_name()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let session_id = extract_session_id(provider, &stdout, &stderr);

    Ok(ProviderResponse {
        stdout,
        stderr,
        success: output.status.success(),
        session_id,
    })
}

fn execute_provider_streaming(
    provider: Provider,
    mut command: Command,
    prompt: &str,
    on_event: &mut dyn FnMut(ProviderStreamEvent),
) -> Result<ProviderResponse, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute {}: {e}", provider.binary()))?;

    {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            format!(
                "Failed to open {} stdin for prompt delivery.",
                provider.display_name()
            )
        })?;
        stdin.write_all(prompt.as_bytes()).map_err(|e| {
            let _ = child.kill();
            format!(
                "Failed to write prompt to {} stdin: {e}",
                provider.display_name()
            )
        })?;
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        format!(
            "Failed to open {} stdout for streaming.",
            provider.display_name()
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        format!(
            "Failed to open {} stderr for streaming.",
            provider.display_name()
        )
    })?;
    let (stdout_tx, stdout_rx) = mpsc::channel::<Result<Option<String>, String>>();
    let stdout_reader = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
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
        let mut reader = BufReader::new(stderr);
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
                if let Some(text) = provider_stream_delta(provider, &line) {
                    let delta = stream_delta_suffix(&mut emitted_text, &text);
                    if !delta.is_empty() {
                        on_event(ProviderStreamEvent {
                            event: "delta",
                            provider: provider.id(),
                            text: Some(delta),
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
                .map_err(|e| format!("Failed to poll {}: {e}", provider.display_name()))?;
        }

        if status.is_none() && start.elapsed() >= Duration::from_secs(PROVIDER_TIMEOUT_SECONDS) {
            timed_out = true;
            let _ = child.kill();
            status = Some(
                child
                    .wait()
                    .map_err(|e| format!("Failed to stop {}: {e}", provider.display_name()))?,
            );
        }
    }

    let _ = stdout_reader.join();
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("Failed to join {} stderr reader.", provider.display_name()))?
        .unwrap_or_else(|error| format!("[stderr read error: {error}]"));
    let status = status.unwrap_or_else(|| {
        child
            .wait()
            .expect("child status missing after provider streaming loop")
    });

    if timed_out {
        return Err(format!(
            "{} timed out after {PROVIDER_TIMEOUT_SECONDS} seconds.",
            provider.display_name()
        ));
    }

    let session_id = extract_session_id(provider, &stdout, &stderr);
    Ok(ProviderResponse {
        stdout,
        stderr,
        success: status.success(),
        session_id,
    })
}

fn configure_provider_command(
    command: &mut Command,
    provider: Provider,
    options: &ProviderExecutionOptions,
) {
    match provider {
        Provider::Claude => {
            if options.stream {
                command.args(["-p", "--output-format", "stream-json"]);
                command.arg("--verbose");
                command.arg("--include-partial-messages");
            } else {
                command.args(["-p", "--output-format", "json"]);
            }
            if let Some(session_id) = options.resume_session_id.as_deref() {
                command.args(["--resume", session_id]);
            }
        }
        Provider::Codex => {
            if let Some(session_id) = options.resume_session_id.as_deref() {
                command.args(["exec", "resume"]);
                if options.stream {
                    command.arg("--json");
                }
                command.args(["--skip-git-repo-check", session_id, "-"]);
            } else {
                command.arg("exec");
                if options.stream {
                    command.arg("--json");
                }
                command.args(["--skip-git-repo-check", "-"]);
            }
        }
    }
}

fn extract_session_id(provider: Provider, stdout: &str, stderr: &str) -> Option<String> {
    provider_parse::extract_session_id(provider_kind(provider), stdout, stderr)
}

fn configure_provider_environment(command: &mut Command, provider: Provider) {
    if let Some(path) = augmented_command_path() {
        command.env("PATH", path);
    }

    if provider == Provider::Claude {
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

// ── Response parsing ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActionEnvelope {
    #[serde(default = "default_action_status")]
    pub status: String,
    #[serde(default)]
    pub actions: Vec<AgentAction>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentAction {
    #[serde(rename_all = "camelCase")]
    AddThread {
        #[serde(default)]
        document_id: Option<String>,
        #[serde(default)]
        relative_path: Option<String>,
        quote: String,
        #[serde(default = "default_quote_occurrence")]
        quote_occurrence: usize,
        #[serde(default)]
        title: Option<String>,
        body: String,
        #[serde(default)]
        tags: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReplyToThread {
        thread_id: String,
        #[serde(default)]
        reply_to_message_id: Option<String>,
        body: String,
    },
    #[serde(rename_all = "camelCase")]
    ProposeRevision {
        thread_id: String,
        #[serde(default)]
        assistant_message: String,
        #[serde(default)]
        response_mode: Option<String>,
        #[serde(default)]
        updated_document_text: Option<String>,
        #[serde(default)]
        unified_diff: Option<String>,
        #[serde(default)]
        resolve_thread_ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Noop {
        #[serde(default)]
        reason: Option<String>,
    },
}

fn default_action_status() -> String {
    "ok".into()
}

fn default_quote_occurrence() -> usize {
    1
}

pub fn parse_action_envelope_response(
    provider: Provider,
    response: &ProviderResponse,
) -> Result<AgentActionEnvelope, String> {
    let raw = response.stdout.trim().to_string();
    if raw.is_empty() {
        return Err("Provider returned empty output.".into());
    }

    let json_text = provider_json_text(provider, &raw);
    let json_str = extract_json_block(&json_text);
    let envelope: AgentActionEnvelope = serde_json::from_str(&json_str).map_err(|error| {
        format!("Unable to parse provider action envelope as JSON: {error}\nRaw output:\n{raw}")
    })?;

    if envelope.status != "ok" {
        return Err(format!(
            "Provider action envelope returned status {:?}.",
            envelope.status
        ));
    }

    Ok(envelope)
}

/// For feedback: extract the text reply from provider output.
/// Claude with --output-format json returns a JSON object with a "result" field.
/// Codex returns plain text.
pub fn parse_feedback_response(
    provider: Provider,
    response: &ProviderResponse,
) -> Result<String, String> {
    let raw = response.stdout.trim();
    if raw.is_empty() {
        return Err("Provider returned empty output.".into());
    }

    provider_parse::parse_feedback_response(provider_kind(provider), raw)
}

/// For revision: extract the assistant message and updated document text.
pub struct RevisionResult {
    pub assistant_message: String,
    pub updated_document_text: String,
    pub resolve_thread_ids: Vec<String>,
}

pub struct FocusedRevisionResult {
    pub assistant_message: String,
    pub replacement_text: String,
    pub resolve_thread_ids: Vec<String>,
}

pub fn parse_revision_response(
    provider: Provider,
    response: &ProviderResponse,
) -> Result<RevisionResult, String> {
    let raw = response.stdout.trim();
    if raw.is_empty() {
        return Err("Provider returned empty output.".into());
    }
    let parsed = provider_parse::parse_document_revision_response(provider_kind(provider), raw)?;

    Ok(RevisionResult {
        assistant_message: parsed.assistant_message,
        updated_document_text: parsed.updated_document_text,
        resolve_thread_ids: parsed.resolve_thread_ids,
    })
}

pub fn parse_focused_revision_response(
    provider: Provider,
    response: &ProviderResponse,
) -> Result<FocusedRevisionResult, String> {
    let raw = response.stdout.trim();
    if raw.is_empty() {
        return Err("Provider returned empty output.".into());
    }
    let parsed = provider_parse::parse_focused_revision_response(provider_kind(provider), raw)?;

    Ok(FocusedRevisionResult {
        assistant_message: parsed.assistant_message,
        replacement_text: parsed.replacement_text,
        resolve_thread_ids: parsed.resolve_thread_ids,
    })
}

fn provider_json_text(provider: Provider, raw: &str) -> String {
    provider_parse::provider_response_text(provider_kind(provider), raw)
}

fn stream_delta_suffix(buffer: &mut String, candidate: &str) -> String {
    provider_parse::stream_delta_suffix(buffer, candidate)
}

fn provider_stream_delta(provider: Provider, line: &str) -> Option<String> {
    provider_parse::provider_stream_delta(provider_kind(provider), line)
}

/// Extract a JSON block from text that might contain ```json ... ``` fences.
fn extract_json_block(text: &str) -> String {
    provider_parse::extract_json_block(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[cfg(unix)]
    fn write_mock_provider(path: &Path) {
        fs::write(path, "#!/bin/sh\nprintf 'args:%s\\n' \"$*\" >&2\ncat\n")
            .expect("write mock provider");
        let mut permissions = fs::metadata(path)
            .expect("mock provider metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("chmod mock provider");
    }

    #[cfg(unix)]
    fn temp_provider_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        env::temp_dir().join(format!(
            "margent-provider-test-{}-{nanos}",
            std::process::id()
        ))
    }

    #[cfg(unix)]
    fn with_mock_provider_path<F>(binary: &str, run: F) -> Result<ProviderResponse, String>
    where
        F: FnOnce() -> Result<ProviderResponse, String>,
    {
        let _guard = env_lock().lock().expect("env test lock");
        let dir = temp_provider_dir();
        fs::create_dir_all(&dir).expect("create temp provider dir");
        write_mock_provider(&dir.join(binary));

        let original_path = env::var_os("PATH");
        let mut next_path = OsString::from(dir.as_os_str());
        if let Some(path) = &original_path {
            next_path.push(":");
            next_path.push(path);
        }
        env::set_var("PATH", next_path);

        let result = run();

        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        let _ = fs::remove_dir_all(&dir);

        result
    }

    #[test]
    #[cfg(unix)]
    fn execute_codex_sends_prompt_over_stdin() {
        let response = with_mock_provider_path("codex", || {
            execute_provider_with_options(
                Provider::Codex,
                "secret document prompt",
                ProviderExecutionOptions::default(),
            )
        })
        .expect("execute mock codex");

        assert!(response.success);
        assert_eq!(response.stdout, "secret document prompt");
        assert!(response
            .stderr
            .contains("args:exec --skip-git-repo-check -"));
        assert!(!response.stderr.contains("secret document prompt"));
    }

    #[test]
    #[cfg(unix)]
    fn execute_claude_sends_prompt_over_stdin() {
        let response = with_mock_provider_path("claude", || {
            execute_provider_with_options(
                Provider::Claude,
                "secret document prompt",
                ProviderExecutionOptions::default(),
            )
        })
        .expect("execute mock claude");

        assert!(response.success);
        assert_eq!(response.stdout, "secret document prompt");
        assert!(response.stderr.contains("args:-p --output-format json"));
        assert!(!response.stderr.contains("secret document prompt"));
    }

    #[test]
    #[cfg(unix)]
    fn execute_codex_resume_uses_session_id() {
        let response = with_mock_provider_path("codex", || {
            execute_provider_with_options(
                Provider::Codex,
                "follow-up prompt",
                ProviderExecutionOptions {
                    resume_session_id: Some("session-123".into()),
                    stream: false,
                },
            )
        })
        .expect("execute mock codex resume");

        assert!(response
            .stderr
            .contains("args:exec resume --skip-git-repo-check session-123 -"));
        assert_eq!(response.stdout, "follow-up prompt");
    }

    #[test]
    #[cfg(unix)]
    fn execute_claude_resume_uses_session_id() {
        let response = with_mock_provider_path("claude", || {
            execute_provider_with_options(
                Provider::Claude,
                "follow-up prompt",
                ProviderExecutionOptions {
                    resume_session_id: Some("session-abc".into()),
                    stream: false,
                },
            )
        })
        .expect("execute mock claude resume");

        assert!(response
            .stderr
            .contains("args:-p --output-format json --resume session-abc"));
        assert_eq!(response.stdout, "follow-up prompt");
    }

    #[test]
    #[cfg(unix)]
    fn execute_codex_stream_uses_json_event_mode() {
        let response = with_mock_provider_path("codex", || {
            execute_provider_with_options(
                Provider::Codex,
                "streamed prompt",
                ProviderExecutionOptions {
                    resume_session_id: Some("session-123".into()),
                    stream: true,
                },
            )
        })
        .expect("execute mock codex stream");

        assert!(response
            .stderr
            .contains("args:exec resume --json --skip-git-repo-check session-123 -"));
        assert_eq!(response.stdout.trim_end(), "streamed prompt");
    }

    #[test]
    #[cfg(unix)]
    fn execute_claude_stream_uses_stream_json_mode() {
        let response = with_mock_provider_path("claude", || {
            execute_provider_with_options(
                Provider::Claude,
                "streamed prompt",
                ProviderExecutionOptions {
                    resume_session_id: Some("session-abc".into()),
                    stream: true,
                },
            )
        })
        .expect("execute mock claude stream");

        assert!(response.stderr.contains(
            "args:-p --output-format stream-json --verbose --include-partial-messages --resume session-abc"
        ));
        assert_eq!(response.stdout.trim_end(), "streamed prompt");
    }

    #[test]
    fn parses_stream_result_from_json_lines() {
        let response = ProviderResponse {
            stdout: "{\"type\":\"message_delta\",\"delta\":\"Ignored live\"}\n{\"session_id\":\"session-1\",\"result\":\"Final answer\"}\n".into(),
            stderr: String::new(),
            success: true,
            session_id: Some("session-1".into()),
        };

        let feedback =
            parse_feedback_response(Provider::Codex, &response).expect("parse stream feedback");

        assert_eq!(feedback, "Final answer");
    }

    #[test]
    fn parses_codex_agent_message_from_jsonl_stream() {
        let response = ProviderResponse {
            stdout: "{\"type\":\"thread.started\",\"thread_id\":\"thread-current\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"web_search\",\"text\":\"ignored\"}}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Actual Codex answer\"}}\n".into(),
            stderr: String::new(),
            success: true,
            session_id: Some("thread-current".into()),
        };

        let feedback =
            parse_feedback_response(Provider::Codex, &response).expect("parse codex stream");

        assert_eq!(feedback, "Actual Codex answer");
    }

    #[test]
    fn parses_focused_revision_from_embedded_json() {
        let response = ProviderResponse {
            stdout: "Here is the JSON:\n{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}\nDone.".into(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let revision = parse_focused_revision_response(Provider::Codex, &response)
            .expect("parse focused revision");

        assert_eq!(revision.assistant_message, "Tightened");
        assert_eq!(revision.replacement_text, "New text");
        assert!(revision.resolve_thread_ids.is_empty());
    }

    #[test]
    fn focused_revision_handles_trailing_prose_after_json_object() {
        let response = ProviderResponse {
            stdout: "{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}\n\nThat should help.".into(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let revision = parse_focused_revision_response(Provider::Codex, &response)
            .expect("parse focused revision");

        assert_eq!(revision.assistant_message, "Tightened");
        assert_eq!(revision.replacement_text, "New text");
    }

    #[test]
    fn focused_revision_skips_non_matching_embedded_braces() {
        let response = ProviderResponse {
            stdout: "Use `{name}` as a placeholder. Example: {\"foo\":42}. Real response:\n{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}".into(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let revision = parse_focused_revision_response(Provider::Codex, &response)
            .expect("parse focused revision");

        assert_eq!(revision.assistant_message, "Tightened");
        assert_eq!(revision.replacement_text, "New text");
    }

    #[test]
    fn focused_revision_handles_concatenated_agent_messages_around_json() {
        let response = ProviderResponse {
            stdout: "Done.{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}".into(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let revision = parse_focused_revision_response(Provider::Codex, &response)
            .expect("parse focused revision");

        assert_eq!(revision.assistant_message, "Tightened");
        assert_eq!(revision.replacement_text, "New text");
    }

    #[test]
    fn document_revision_handles_prose_around_json() {
        let response = ProviderResponse {
            stdout: "Here is the revised document:\n{\"assistantMessage\":\"Rewrote intro\",\"updatedDocumentText\":\"# New title\\nBody.\\n\",\"resolveThreadIds\":[]}\nDone.".into(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let revision =
            parse_revision_response(Provider::Codex, &response).expect("parse document revision");

        assert_eq!(revision.assistant_message, "Rewrote intro");
        assert_eq!(revision.updated_document_text, "# New title\nBody.\n");
    }

    #[test]
    fn focused_revision_accepts_plain_replacement_text() {
        let response = ProviderResponse {
            stdout: "Revised passage:\nThis paragraph is clearer and more direct.".into(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let revision = parse_focused_revision_response(Provider::Codex, &response)
            .expect("parse focused revision");

        assert_eq!(
            revision.assistant_message,
            "Proposed a replacement for the selected passage."
        );
        assert_eq!(
            revision.replacement_text,
            "This paragraph is clearer and more direct."
        );
        assert!(revision.resolve_thread_ids.is_empty());
    }

    #[test]
    fn extracts_codex_thread_id_from_jsonl_stream() {
        let stdout = "{\"type\":\"thread.started\",\"thread_id\":\"019ec99e-c42a\"}\n";

        assert_eq!(
            extract_session_id(Provider::Codex, stdout, ""),
            Some("019ec99e-c42a".into())
        );
    }

    #[test]
    fn parses_claude_action_envelope_from_result_field() {
        let result = serde_json::json!({
            "status": "ok",
            "actions": [{
                "type": "reply_to_thread",
                "threadId": "thread_1",
                "replyToMessageId": "msg_1",
                "body": "This needs a sharper verb."
            }],
            "warnings": ["minor caveat"]
        })
        .to_string();
        let response = ProviderResponse {
            stdout: serde_json::json!({ "result": result }).to_string(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let envelope = parse_action_envelope_response(Provider::Claude, &response)
            .expect("parse claude action envelope");

        assert_eq!(envelope.warnings, vec!["minor caveat"]);
        assert_eq!(envelope.actions.len(), 1);
        match &envelope.actions[0] {
            AgentAction::ReplyToThread {
                thread_id,
                reply_to_message_id,
                body,
            } => {
                assert_eq!(thread_id, "thread_1");
                assert_eq!(reply_to_message_id.as_deref(), Some("msg_1"));
                assert_eq!(body, "This needs a sharper verb.");
            }
            other => panic!("expected reply action, got {other:?}"),
        }
    }

    #[test]
    fn parses_codex_action_envelope_from_fenced_json() {
        let response = ProviderResponse {
            stdout: "Here is the envelope:\n```json\n{\"status\":\"ok\",\"actions\":[{\"type\":\"noop\",\"reason\":\"already handled\"}],\"warnings\":[]}\n```".into(),
            stderr: String::new(),
            success: true,
            session_id: None,
        };

        let envelope = parse_action_envelope_response(Provider::Codex, &response)
            .expect("parse codex action envelope");

        assert_eq!(envelope.actions.len(), 1);
        match &envelope.actions[0] {
            AgentAction::Noop { reason } => {
                assert_eq!(reason.as_deref(), Some("already handled"));
            }
            other => panic!("expected noop action, got {other:?}"),
        }
    }
}
