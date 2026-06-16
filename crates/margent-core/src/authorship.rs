use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

use crate::document::content_hash;
use crate::thread::AnchorRecord;

pub const CURRENT_AUTHORSHIP_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorshipMapRecord {
    pub schema_version: u8,
    pub document_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub updated_at: String,
    pub spans: Vec<AuthorshipSpanRecord>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorshipSpanRecord {
    pub id: String,
    pub anchor: AnchorRecord,
    pub quote: String,
    pub source: AuthorshipSourceRecord,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorshipSourceRecord {
    pub proposal_id: String,
    pub adapter_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub author_name: String,
    pub accepted_at: String,
    pub edited_at_accept: bool,
}

pub fn build_authorship_record<F>(
    document_id: &str,
    relative_path: &str,
    before: &str,
    after: &str,
    updated_at: &str,
    source: AuthorshipSourceRecord,
    mut next_span_id: F,
) -> AuthorshipMapRecord
where
    F: FnMut() -> String,
{
    let spans = inserted_ranges(before, after)
        .into_iter()
        .filter_map(|(start, end)| {
            if start == end {
                return None;
            }
            let quote = after[start..end].to_string();
            Some(AuthorshipSpanRecord {
                id: next_span_id(),
                anchor: anchor_for_range(after, start, end),
                quote,
                source: source.clone(),
            })
        })
        .collect();

    AuthorshipMapRecord {
        schema_version: CURRENT_AUTHORSHIP_SCHEMA_VERSION,
        document_id: document_id.to_string(),
        relative_path: relative_path.to_string(),
        content_hash: content_hash(after),
        updated_at: updated_at.to_string(),
        spans,
    }
}

fn inserted_ranges(before: &str, after: &str) -> Vec<(usize, usize)> {
    let diff = TextDiff::from_chars(before, after);
    let mut ranges = Vec::new();
    let mut after_offset = 0;
    let mut active_start: Option<usize> = None;

    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                if let Some(start) = active_start.take() {
                    ranges.push((start, after_offset));
                }
                after_offset += change.value().len();
            }
            ChangeTag::Delete => {}
            ChangeTag::Insert => {
                if active_start.is_none() {
                    active_start = Some(after_offset);
                }
                after_offset += change.value().len();
            }
        }
    }

    if let Some(start) = active_start {
        ranges.push((start, after_offset));
    }

    ranges
}

fn anchor_for_range(content: &str, start: usize, end: usize) -> AnchorRecord {
    let quote = content[start..end].to_string();
    let (start_line, start_column) = line_column_for_byte(content, start);
    let (end_line, end_column) = line_column_for_byte(content, end);
    AnchorRecord {
        quote: quote.clone(),
        prefix_context: context_before(content, start),
        suffix_context: context_after(content, end),
        start_offset_utf16: content[..start].encode_utf16().count(),
        end_offset_utf16: content[..end].encode_utf16().count(),
        start_line,
        start_column,
        end_line,
        end_column,
        heading_path: Vec::new(),
        block_fingerprint: content_hash(&quote),
        base_content_hash: content_hash(content),
        kind: "authorship_span".into(),
        footnote: None,
        state: "attached".into(),
        confidence: 1.0,
    }
}

fn line_column_for_byte(content: &str, byte_offset: usize) -> (usize, usize) {
    let mut line = 1;
    let mut column = 1;
    for character in content[..byte_offset].chars() {
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

fn context_before(content: &str, start: usize) -> String {
    content[..start]
        .chars()
        .rev()
        .take(96)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn context_after(content: &str, end: usize) -> String {
    content[end..].chars().take(96).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> AuthorshipSourceRecord {
        AuthorshipSourceRecord {
            proposal_id: "proposal_1".into(),
            adapter_id: "codex".into(),
            agent_id: Some("codex".into()),
            author_name: "Codex".into(),
            accepted_at: "2026-01-01T00:00:00Z".into(),
            edited_at_accept: false,
        }
    }

    #[test]
    fn builds_spans_for_inserted_revision_text() {
        let record = build_authorship_record(
            "doc_1",
            "draft.md",
            "A plain sentence.",
            "A sharper plain sentence.",
            "2026-01-01T00:00:00Z",
            source(),
            || "span_1".into(),
        );

        assert_eq!(record.spans.len(), 1);
        assert_eq!(record.spans[0].quote, "sharper ");
        assert_eq!(record.spans[0].anchor.kind, "authorship_span");
    }

    #[test]
    fn ignores_deletion_only_changes() {
        let record = build_authorship_record(
            "doc_1",
            "draft.md",
            "A very plain sentence.",
            "A plain sentence.",
            "2026-01-01T00:00:00Z",
            source(),
            || "span_1".into(),
        );

        assert!(record.spans.is_empty());
    }
}
