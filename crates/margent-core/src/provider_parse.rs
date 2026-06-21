use serde_json::Value;

use crate::provider_readiness::ProviderKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderDocumentRevision {
    pub assistant_message: String,
    pub updated_document_text: String,
    pub resolve_thread_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderFocusedRevision {
    pub assistant_message: String,
    pub replacement_text: String,
    pub resolve_thread_ids: Vec<String>,
}

pub fn extract_session_id(provider: ProviderKind, stdout: &str, stderr: &str) -> Option<String> {
    match provider {
        ProviderKind::Claude => extract_json_session_id(stdout),
        ProviderKind::Codex => {
            extract_json_session_id(stdout).or_else(|| extract_json_session_id(stderr))
        }
    }
}

fn extract_json_session_id(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if let Some(session_id) = value
                .get("session_id")
                .or_else(|| value.get("sessionId"))
                .or_else(|| value.get("thread_id"))
                .or_else(|| value.get("threadId"))
                .or_else(|| value.get("conversation_id"))
                .or_else(|| value.get("conversationId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(session_id.to_string());
            }
        }
    }

    None
}

pub fn parse_feedback_response(provider: ProviderKind, raw: &str) -> Result<String, String> {
    let response_text = provider_response_text(provider, raw);
    let feedback = response_text.trim();
    if feedback.is_empty() {
        return Err(format!(
            "{} returned empty feedback.",
            provider.display_name()
        ));
    }
    Ok(feedback.to_string())
}

pub fn parse_focused_revision_response(
    provider: ProviderKind,
    raw: &str,
) -> Result<ProviderFocusedRevision, String> {
    let response_text = provider_response_text(provider, raw);
    let parsed: Value = match parse_revision_json(&response_text, &["replacementText"]) {
        Ok(parsed) => parsed,
        Err(error) => {
            if let Some(fallback) = focused_revision_from_plain_text(&response_text) {
                return Ok(fallback);
            }

            return Err(format!(
                "Unable to parse {} revision response as JSON: {error}. Response began: {}",
                provider.display_name(),
                preview_provider_text(&response_text)
            ));
        }
    };
    let assistant_message = parsed
        .get("assistantMessage")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let replacement_text = parsed
        .get("replacementText")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "{} response missing replacementText.",
                provider.display_name()
            )
        })?
        .to_string();
    let resolve_thread_ids = parse_resolve_thread_ids(&parsed);

    Ok(ProviderFocusedRevision {
        assistant_message,
        replacement_text,
        resolve_thread_ids,
    })
}

pub fn parse_document_revision_response(
    provider: ProviderKind,
    raw: &str,
) -> Result<ProviderDocumentRevision, String> {
    let response_text = provider_response_text(provider, raw);
    let parsed: Value =
        parse_revision_json(&response_text, &["updatedDocumentText", "replacementText"]).map_err(
            |error| {
                format!(
            "Unable to parse {} document revision response as JSON: {error}. Response began: {}",
            provider.display_name(),
            preview_provider_text(&response_text)
        )
            },
        )?;
    let assistant_message = parsed
        .get("assistantMessage")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let updated_document_text = parsed
        .get("updatedDocumentText")
        .and_then(Value::as_str)
        .or_else(|| parsed.get("replacementText").and_then(Value::as_str))
        .ok_or_else(|| {
            format!(
                "{} response missing updatedDocumentText.",
                provider.display_name()
            )
        })?
        .to_string();
    let resolve_thread_ids = parse_resolve_thread_ids(&parsed);

    Ok(ProviderDocumentRevision {
        assistant_message,
        updated_document_text,
        resolve_thread_ids,
    })
}

fn parse_resolve_thread_ids(parsed: &Value) -> Vec<String> {
    parsed
        .get("resolveThreadIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub fn provider_response_text(provider: ProviderKind, raw: &str) -> String {
    let trimmed = raw.trim();

    if let Some(stream_text) = provider_stream_response_text(provider, trimmed) {
        return stream_text;
    }

    match provider {
        ProviderKind::Claude => serde_json::from_str::<Value>(trimmed)
            .ok()
            .and_then(|value| {
                value
                    .get("result")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| value.as_str().map(str::to_string))
                    .or_else(|| Some(value.to_string()))
            })
            .unwrap_or_else(|| trimmed.to_string()),
        ProviderKind::Codex => trimmed.to_string(),
    }
}

fn provider_stream_response_text(provider: ProviderKind, raw: &str) -> Option<String> {
    let mut last_result: Option<String> = None;
    let mut delta_text = String::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(result) = value.get("result").and_then(Value::as_str) {
            last_result = Some(result.to_string());
            continue;
        }
        if let Some(result) = value
            .get("message")
            .and_then(|message| message.get("result"))
            .and_then(Value::as_str)
        {
            last_result = Some(result.to_string());
            continue;
        }
        if let Some(delta) = provider_stream_delta_from_value(provider, &value) {
            let _ = stream_delta_suffix(&mut delta_text, &delta);
        }
    }

    if let Some(result) = last_result {
        return Some(result);
    }
    (!delta_text.is_empty()).then_some(delta_text)
}

pub fn provider_stream_delta(provider: ProviderKind, line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line.trim()).ok()?;
    provider_stream_delta_from_value(provider, &value)
}

fn provider_stream_delta_from_value(provider: ProviderKind, value: &Value) -> Option<String> {
    if value.get("result").is_some() {
        return None;
    }

    if provider == ProviderKind::Codex {
        if let Some(text) = codex_agent_message_text(value) {
            return Some(text);
        }
    }

    for path in [
        &["delta"][..],
        &["text"][..],
        &["content_delta"][..],
        &["message", "delta"][..],
        &["message", "text"][..],
        &["delta", "text"][..],
        &["event", "delta"][..],
        &["event", "text"][..],
        &["output", "text"][..],
    ] {
        if let Some(text) = string_at_path(value, path) {
            return Some(text.to_string());
        }
    }

    if let Some(text) = collect_content_text(value.get("content")) {
        return Some(text);
    }
    if let Some(text) = collect_content_text(
        value
            .get("message")
            .and_then(|message| message.get("content")),
    ) {
        return Some(text);
    }
    if let Some(text) = collect_content_text(value.get("item").and_then(|item| item.get("content")))
    {
        return Some(text);
    }

    None
}

fn codex_agent_message_text(value: &Value) -> Option<String> {
    let item = value.get("item")?;
    let item_type = item.get("type").and_then(Value::as_str)?;

    match item_type {
        "agent_message" => {}
        "message" => {
            if let Some(role) = item.get("role").and_then(Value::as_str) {
                if role != "assistant" {
                    return None;
                }
            }
        }
        _ => return None,
    }

    string_at_path(value, &["item", "text"])
        .map(str::to_string)
        .or_else(|| collect_content_text(item.get("content")))
}

fn string_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str().filter(|text| !text.trim().is_empty())
}

fn collect_content_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.to_string()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                })
                .collect::<Vec<_>>()
                .join("");
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(_) => value
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

pub fn stream_delta_suffix(buffer: &mut String, candidate: &str) -> String {
    if candidate.is_empty() {
        return String::new();
    }

    let delta = if !buffer.is_empty() && candidate.starts_with(buffer.as_str()) {
        candidate[buffer.len()..].to_string()
    } else {
        candidate.to_string()
    };
    buffer.push_str(&delta);
    delta
}

pub fn extract_json_block(text: &str) -> String {
    let trimmed = text.trim();

    if trimmed.starts_with('{') {
        if let Some(json_object) = extract_balanced_json_object(trimmed) {
            return json_object;
        }
        return trimmed.to_string();
    }

    if let Some(start) = trimmed.find("```json") {
        let after_fence = &trimmed[start + 7..];
        if let Some(end) = after_fence.find("```") {
            return after_fence[..end].trim().to_string();
        }
    }

    if let Some(start) = trimmed.find("```") {
        let after_fence = &trimmed[start + 3..];
        let after_newline = if let Some(newline) = after_fence.find('\n') {
            &after_fence[newline + 1..]
        } else {
            after_fence
        };
        if let Some(end) = after_newline.find("```") {
            return after_newline[..end].trim().to_string();
        }
    }

    if let Some(json_object) = extract_balanced_json_object(trimmed) {
        return json_object;
    }

    trimmed.to_string()
}

fn parse_revision_json(response_text: &str, expected_keys: &[&str]) -> Result<Value, String> {
    let block = extract_json_block(response_text);

    if let Ok(value) = serde_json::from_str::<Value>(&block) {
        if value.is_object() && object_has_any_key(&value, expected_keys) {
            return Ok(value);
        }
    }

    if let Some(value) = find_revision_object_in_text(response_text, expected_keys) {
        return Ok(value);
    }

    serde_json::from_str::<Value>(&block).map_err(|error| error.to_string())
}

fn object_has_any_key(value: &Value, keys: &[&str]) -> bool {
    match value {
        Value::Object(map) => keys.iter().any(|key| map.contains_key(*key)),
        _ => false,
    }
}

fn find_revision_object_in_text(text: &str, expected_keys: &[&str]) -> Option<Value> {
    let mut cursor = 0usize;
    while cursor < text.len() {
        let slice = &text[cursor..];
        let Some(rel_index) = slice.find('{') else {
            break;
        };
        let start = cursor + rel_index;
        if let Some(candidate) = extract_balanced_json_object(&text[start..]) {
            if let Ok(value) = serde_json::from_str::<Value>(&candidate) {
                if value.is_object() && object_has_any_key(&value, expected_keys) {
                    return Some(value);
                }
            }
            cursor = start + 1;
        } else {
            break;
        }
    }
    None
}

fn extract_balanced_json_object(text: &str) -> Option<String> {
    for (start, character) in text.char_indices() {
        if character != '{' {
            continue;
        }

        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;

        for (relative_index, current) in text[start..].char_indices() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if current == '\\' {
                    escaped = true;
                } else if current == '"' {
                    in_string = false;
                }
                continue;
            }

            match current {
                '"' => in_string = true,
                '{' => depth += 1,
                '}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        let end = start + relative_index + current.len_utf8();
                        return Some(text[start..end].trim().to_string());
                    }
                }
                _ => {}
            }
        }
    }

    None
}

fn focused_revision_from_plain_text(response_text: &str) -> Option<ProviderFocusedRevision> {
    let replacement_text = plain_replacement_text(response_text)?;
    Some(ProviderFocusedRevision {
        assistant_message: "Proposed a replacement for the selected passage.".into(),
        replacement_text,
        resolve_thread_ids: Vec::new(),
    })
}

fn plain_replacement_text(response_text: &str) -> Option<String> {
    let mut candidate = extract_json_block(response_text).trim().to_string();
    if candidate.is_empty() || candidate.starts_with('{') {
        return None;
    }

    for prefix in [
        "Here is the revised passage:",
        "Here's the revised passage:",
        "Revised passage:",
        "Replacement:",
        "replacementText:",
    ] {
        if candidate
            .get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
        {
            candidate = candidate[prefix.len()..].trim().to_string();
            break;
        }
    }

    (!candidate.trim().is_empty()).then_some(candidate)
}

pub fn preview_provider_text(text: &str) -> String {
    let normalized = text.replace('\n', "\\n");
    let mut chars = normalized.chars();
    let preview = chars.by_ref().take(220).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_from_fenced_provider_response() {
        let raw = "Done.\n```json\n{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[\"thread_1\"]}\n```";
        let parsed =
            parse_focused_revision_response(ProviderKind::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
        assert_eq!(parsed.resolve_thread_ids, vec!["thread_1"]);
    }

    #[test]
    fn skips_non_matching_embedded_braces() {
        let raw = "Use the `{name}` syntax. Then respond like:\n{\"foo\":42}\nFinally:\n{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}\n";
        let parsed =
            parse_focused_revision_response(ProviderKind::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
    }

    #[test]
    fn handles_concatenated_agent_messages_around_json() {
        let raw = "Done.{\"assistantMessage\":\"Tightened\",\"replacementText\":\"New text\",\"resolveThreadIds\":[]}";
        let parsed =
            parse_focused_revision_response(ProviderKind::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Tightened");
        assert_eq!(parsed.replacement_text, "New text");
    }

    #[test]
    fn document_revision_handles_prose_around_json() {
        let raw = "Here is the revised document:\n{\"assistantMessage\":\"Rewrote intro\",\"updatedDocumentText\":\"# New title\\nBody.\\n\",\"resolveThreadIds\":[]}\nDone.";
        let parsed =
            parse_document_revision_response(ProviderKind::Codex, raw).expect("parse response");

        assert_eq!(parsed.assistant_message, "Rewrote intro");
        assert_eq!(parsed.updated_document_text, "# New title\nBody.\n");
    }

    #[test]
    fn focused_revision_accepts_plain_replacement_text() {
        let raw = "Revised passage:\nThis paragraph is clearer and more direct.";
        let parsed =
            parse_focused_revision_response(ProviderKind::Codex, raw).expect("parse response");

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
    fn provider_response_text_prefers_stream_result() {
        let raw = "{\"type\":\"message_delta\",\"delta\":\"Partial\"}\n{\"session_id\":\"session-1\",\"result\":\"Final answer\"}\n";

        assert_eq!(
            provider_response_text(ProviderKind::Codex, raw),
            "Final answer"
        );
    }

    #[test]
    fn provider_response_text_reads_codex_agent_message_events() {
        let raw = "{\"type\":\"thread.started\",\"thread_id\":\"thread-current\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"web_search\",\"text\":\"ignored\"}}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Actual Codex answer\"}}\n";

        assert_eq!(
            provider_response_text(ProviderKind::Codex, raw),
            "Actual Codex answer"
        );
    }

    #[test]
    fn extracts_codex_thread_id_from_jsonl_stream() {
        let stdout = "{\"type\":\"thread.started\",\"thread_id\":\"019ec99e-c42a\"}\n";

        assert_eq!(
            extract_session_id(ProviderKind::Codex, stdout, ""),
            Some("019ec99e-c42a".into())
        );
    }
}
