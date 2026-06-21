use serde::{Deserialize, Serialize};

use crate::proposal::ProposalRecord;
use crate::thread::{AnchorRecord, ThreadRecord};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticMarkupOutput {
    pub content: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticImportPlan {
    pub base_content: String,
    pub comments: Vec<CriticImportComment>,
    pub replacements: Vec<CriticImportReplacement>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticImportComment {
    pub quote: String,
    pub body: String,
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticImportReplacement {
    pub old_text: String,
    pub new_text: String,
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Clone, Debug)]
struct CriticOperation {
    start: usize,
    end: usize,
    replacement: String,
    label: String,
}

pub fn render_critic_markup(
    content: &str,
    threads: &[ThreadRecord],
    proposals: &[ProposalRecord],
    include_resolved: bool,
) -> CriticMarkupOutput {
    let mut warnings = Vec::new();
    let mut operations = Vec::new();

    for thread in threads {
        if !include_resolved && thread.status == "resolved" {
            continue;
        }
        if thread.anchor.kind == "document" {
            warnings.push(format!("Skipped document-level thread {}.", thread.id));
            continue;
        }
        let Some((start, end, quote)) = anchored_text(content, &thread.anchor) else {
            warnings.push(format!(
                "Skipped thread {} with an invalid anchor.",
                thread.id
            ));
            continue;
        };
        if quote.is_empty() {
            warnings.push(format!(
                "Skipped thread {} with an empty anchor.",
                thread.id
            ));
            continue;
        }
        let comment = critic_comment_body(thread);
        operations.push(CriticOperation {
            start,
            end,
            replacement: format!("{{=={quote}==}}{{>>{comment}<<}}"),
            label: format!("thread {}", thread.id),
        });
    }

    for proposal in proposals
        .iter()
        .filter(|proposal| proposal.status == "pending")
    {
        let Some(updated_document_text) = proposal.updated_document_text.as_deref() else {
            warnings.push(format!(
                "Skipped proposal {} because it has no updatedDocumentText.",
                proposal.id
            ));
            continue;
        };
        let Some(thread) = proposal
            .thread_ids
            .iter()
            .find_map(|thread_id| threads.iter().find(|thread| thread.id == *thread_id))
        else {
            warnings.push(format!(
                "Skipped proposal {} because no linked thread was loaded.",
                proposal.id
            ));
            continue;
        };
        if thread.anchor.kind == "document" {
            warnings.push(format!(
                "Skipped proposal {} because document-level substitutions are not exportable as a focused CriticMarkup range.",
                proposal.id
            ));
            continue;
        }
        let Some((start, end, old_text)) = anchored_text(content, &thread.anchor) else {
            warnings.push(format!(
                "Skipped proposal {} with an invalid anchor.",
                proposal.id
            ));
            continue;
        };
        let Some(new_text) = infer_focused_replacement(content, updated_document_text, start, end)
        else {
            warnings.push(format!(
                "Skipped proposal {} because its replacement is not limited to the anchored range.",
                proposal.id
            ));
            continue;
        };
        if old_text == new_text {
            warnings.push(format!(
                "Skipped proposal {} because the inferred replacement is unchanged.",
                proposal.id
            ));
            continue;
        }
        operations.push(CriticOperation {
            start,
            end,
            replacement: format!("{{~~{old_text}~>{new_text}~~}}"),
            label: format!("proposal {}", proposal.id),
        });
    }

    operations.sort_by(|left, right| left.start.cmp(&right.start).then(left.end.cmp(&right.end)));
    let mut accepted = Vec::new();
    let mut last_end = 0;
    for operation in operations {
        if operation.start < last_end {
            warnings.push(format!("Skipped overlapping {}.", operation.label));
            continue;
        }
        last_end = operation.end;
        accepted.push(operation);
    }

    let mut rendered = content.to_string();
    for operation in accepted.into_iter().rev() {
        rendered.replace_range(operation.start..operation.end, &operation.replacement);
    }

    CriticMarkupOutput {
        content: rendered,
        warnings,
    }
}

pub fn parse_critic_markup(marked_content: &str) -> CriticImportPlan {
    let mut base_content = String::new();
    let mut comments = Vec::new();
    let mut replacements = Vec::new();
    let mut warnings = Vec::new();
    let mut index = 0;

    while index < marked_content.len() {
        let rest = &marked_content[index..];
        if rest.starts_with("{==") {
            if let Some(end_highlight) = rest.find("==}") {
                let quote = &rest[3..end_highlight];
                let after_highlight = index + end_highlight + 3;
                let after_rest = &marked_content[after_highlight..];
                if after_rest.starts_with("{>>") {
                    if let Some(end_comment) = after_rest.find("<<}") {
                        let body = &after_rest[3..end_comment];
                        let start_byte = base_content.len();
                        base_content.push_str(quote);
                        let end_byte = base_content.len();
                        comments.push(CriticImportComment {
                            quote: quote.to_string(),
                            body: body.trim().to_string(),
                            start_byte,
                            end_byte,
                        });
                        index = after_highlight + end_comment + 3;
                        continue;
                    }
                }
            }
        }

        if rest.starts_with("{~~") {
            if let Some(end) = rest.find("~~}") {
                let inner = &rest[3..end];
                if let Some(split) = inner.find("~>") {
                    let old_text = &inner[..split];
                    let new_text = &inner[split + 2..];
                    let start_byte = base_content.len();
                    base_content.push_str(old_text);
                    let end_byte = base_content.len();
                    replacements.push(CriticImportReplacement {
                        old_text: old_text.to_string(),
                        new_text: new_text.to_string(),
                        start_byte,
                        end_byte,
                    });
                    index += end + 3;
                    continue;
                }
            }
        }

        if rest.starts_with("{--") {
            if let Some(end) = rest.find("--}") {
                let old_text = &rest[3..end];
                let start_byte = base_content.len();
                base_content.push_str(old_text);
                let end_byte = base_content.len();
                replacements.push(CriticImportReplacement {
                    old_text: old_text.to_string(),
                    new_text: String::new(),
                    start_byte,
                    end_byte,
                });
                index += end + 3;
                continue;
            }
        }

        if rest.starts_with("{++") {
            if let Some(end) = rest.find("++}") {
                let new_text = &rest[3..end];
                replacements.push(CriticImportReplacement {
                    old_text: String::new(),
                    new_text: new_text.to_string(),
                    start_byte: base_content.len(),
                    end_byte: base_content.len(),
                });
                warnings.push(
                    "Parsed an insertion-only CriticMarkup suggestion; import will anchor it at the insertion point.".into(),
                );
                index += end + 3;
                continue;
            }
        }

        if rest.starts_with("{>>") {
            if let Some(end) = rest.find("<<}") {
                let body = &rest[3..end];
                comments.push(CriticImportComment {
                    quote: String::new(),
                    body: body.trim().to_string(),
                    start_byte: base_content.len(),
                    end_byte: base_content.len(),
                });
                warnings.push(
                    "Parsed a bare CriticMarkup comment; import will create a document-level thread.".into(),
                );
                index += end + 3;
                continue;
            }
        }

        let Some(character) = rest.chars().next() else {
            break;
        };
        base_content.push(character);
        index += character.len_utf8();
    }

    CriticImportPlan {
        base_content,
        comments,
        replacements,
        warnings,
    }
}

fn anchored_text<'a>(content: &'a str, anchor: &AnchorRecord) -> Option<(usize, usize, &'a str)> {
    if matches!(anchor.state.as_str(), "detached" | "needs_review") {
        return None;
    }
    let start = utf16_to_byte_index(content, anchor.start_offset_utf16)?;
    let end = utf16_to_byte_index(content, anchor.end_offset_utf16)?;
    if start > end || end > content.len() {
        return None;
    }
    Some((start, end, &content[start..end]))
}

fn infer_focused_replacement(
    original: &str,
    updated: &str,
    start: usize,
    end: usize,
) -> Option<String> {
    let prefix = &original[..start];
    let suffix = &original[end..];
    if !updated.starts_with(prefix) || !updated.ends_with(suffix) {
        return None;
    }
    let replacement_end = updated.len().checked_sub(suffix.len())?;
    if prefix.len() > replacement_end {
        return None;
    }
    Some(updated[prefix.len()..replacement_end].to_string())
}

fn critic_comment_body(thread: &ThreadRecord) -> String {
    let mut parts = Vec::new();
    if !thread.title.trim().is_empty() {
        parts.push(thread.title.trim().to_string());
    }
    for message in &thread.messages {
        let body = message.body.trim();
        if !body.is_empty() {
            parts.push(format!("{}: {}", message.author_name, body));
        }
    }
    sanitize_comment(&parts.join(" | "))
}

fn sanitize_comment(comment: &str) -> String {
    comment
        .replace("<<", "< <")
        .replace(">>", "> >")
        .replace('\n', " ")
}

fn utf16_to_byte_index(content: &str, target: usize) -> Option<usize> {
    let mut utf16_offset = 0;
    for (byte_index, character) in content.char_indices() {
        if utf16_offset == target {
            return Some(byte_index);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > target {
            return None;
        }
    }
    if utf16_offset == target {
        Some(content.len())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread::{AnchorRecord, MessageRecord, ThreadRecord, CURRENT_THREAD_SCHEMA_VERSION};
    use std::collections::HashMap;

    fn anchor_for(content: &str, quote: &str) -> AnchorRecord {
        let start = content.find(quote).expect("quote exists");
        let end = start + quote.len();
        AnchorRecord {
            quote: quote.into(),
            prefix_context: String::new(),
            suffix_context: String::new(),
            start_offset_utf16: content[..start].encode_utf16().count(),
            end_offset_utf16: content[..end].encode_utf16().count(),
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 1,
            heading_path: Vec::new(),
            block_fingerprint: String::new(),
            base_content_hash: String::new(),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        }
    }

    fn thread(content: &str, quote: &str) -> ThreadRecord {
        ThreadRecord {
            schema_version: CURRENT_THREAD_SCHEMA_VERSION,
            id: "thread_1".into(),
            document_id: "doc".into(),
            status: "open".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            created_by: "user".into(),
            title: "Tighten this".into(),
            tags: Vec::new(),
            anchor: anchor_for(content, quote),
            created_content_hash: None,
            last_reanchor_content_hash: None,
            review_round: None,
            review_done: false,
            messages: vec![MessageRecord {
                id: "msg_1".into(),
                thread_id: "thread_1".into(),
                author_type: "user".into(),
                author_name: "You".into(),
                agent_id: None,
                adapter_id: None,
                reply_to_message_id: None,
                created_at: "2026-01-01T00:00:00Z".into(),
                body: "Please sharpen it.".into(),
                kind: "comment".into(),
            }],
            linked_proposal_ids: Vec::new(),
            provider_sessions: HashMap::new(),
            extra: Default::default(),
        }
    }

    #[test]
    fn renders_thread_comments_as_critic_markup() {
        let content = "First sentence. Second sentence.";
        let rendered =
            render_critic_markup(content, &[thread(content, "Second sentence.")], &[], false);
        assert!(rendered.content.contains("{==Second sentence.==}{>>"));
        assert!(rendered.warnings.is_empty());
    }

    #[test]
    fn parses_highlight_comments_and_replacements() {
        let plan = parse_critic_markup(
            "A {==sentence==}{>>Needs work<<} and {~~old~>new~~} plus {--gone--}.",
        );
        assert_eq!(plan.base_content, "A sentence and old plus gone.");
        assert_eq!(plan.comments[0].quote, "sentence");
        assert_eq!(plan.replacements[0].old_text, "old");
        assert_eq!(plan.replacements[0].new_text, "new");
        assert_eq!(plan.replacements[1].old_text, "gone");
        assert_eq!(plan.replacements[1].new_text, "");
    }
}
