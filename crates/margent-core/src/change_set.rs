use std::collections::{BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

use crate::document::content_hash;

const REVIEW_DIFF_WINDOW_LIMIT_BYTES: usize = 128_000;
const COMPUTED_DIFF_DETAIL_LIMIT_BYTES: usize = 128_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChangeSet {
    pub id: String,
    pub document_id: String,
    pub source: ChangeSource,
    pub before_hash: String,
    pub after_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_hash: Option<String>,
    pub hunks: Vec<ReviewHunk>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewHunk {
    pub id: String,
    pub index: usize,
    pub kind: HunkKind,
    pub old_range: TextRange,
    pub new_range: TextRange,
    pub before_text: String,
    pub after_text: String,
    #[serde(default)]
    pub heading_path: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSource {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HunkKind {
    Insert,
    Delete,
    Replace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub end_line: usize,
}

pub fn build_review_change_set(
    document_id: &str,
    source: ChangeSource,
    before: &str,
    after: &str,
) -> ReviewChangeSet {
    let before_hash = content_hash(before);
    let after_hash = content_hash(after);
    let hunks = build_hunks(&source, before, after);

    ReviewChangeSet {
        id: change_set_id(document_id, &source, &before_hash, &after_hash),
        document_id: document_id.to_string(),
        source,
        before_hash,
        after_hash,
        base_hash: None,
        hunks,
        warnings: Vec::new(),
    }
}

pub fn apply_selected_hunks<I, S>(
    before: &str,
    change_set: &ReviewChangeSet,
    selected_hunk_ids: I,
) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let selected: BTreeSet<String> = selected_hunk_ids
        .into_iter()
        .map(|id| id.as_ref().to_string())
        .collect();
    let known_ids: HashSet<&str> = change_set
        .hunks
        .iter()
        .map(|hunk| hunk.id.as_str())
        .collect();

    if let Some(unknown_id) = selected.iter().find(|id| !known_ids.contains(id.as_str())) {
        return Err(format!("Unknown hunk id: {unknown_id}"));
    }

    if selected.is_empty() {
        return Ok(before.to_string());
    }

    let before_hash = content_hash(before);
    if before_hash != change_set.before_hash {
        return Err(format!(
            "Before text hash mismatch: expected {}, got {}",
            change_set.before_hash, before_hash
        ));
    }

    let mut selected_hunks: Vec<&ReviewHunk> = change_set
        .hunks
        .iter()
        .filter(|hunk| selected.contains(&hunk.id))
        .collect();
    selected_hunks.sort_by(|left, right| {
        left.old_range
            .start_byte
            .cmp(&right.old_range.start_byte)
            .then(left.old_range.end_byte.cmp(&right.old_range.end_byte))
            .then(left.index.cmp(&right.index))
            .then(left.id.cmp(&right.id))
    });

    let mut result = String::with_capacity(before.len());
    let mut cursor = 0;

    for hunk in selected_hunks {
        validate_hunk_range(before, hunk)?;
        if hunk.old_range.start_byte < cursor {
            return Err(format!("Selected hunks overlap at {}", hunk.id));
        }

        result.push_str(&before[cursor..hunk.old_range.start_byte]);
        result.push_str(&hunk.after_text);
        cursor = hunk.old_range.end_byte;
    }

    result.push_str(&before[cursor..]);

    if selected.len() == change_set.hunks.len() && content_hash(&result) != change_set.after_hash {
        return Err(format!(
            "Applied hunks did not reconstruct target hash {}",
            change_set.after_hash
        ));
    }

    Ok(result)
}

pub fn compute_unified_diff(before: &str, after: &str) -> String {
    let change_set = build_review_change_set(
        "computed_diff",
        ChangeSource {
            kind: "computed_diff".into(),
            id: None,
        },
        before,
        after,
    );

    if change_set.hunks.is_empty() {
        return String::new();
    }

    let detail_bytes = change_set
        .hunks
        .iter()
        .map(|hunk| hunk.before_text.len() + hunk.after_text.len())
        .sum::<usize>();

    if detail_bytes > COMPUTED_DIFF_DETAIL_LIMIT_BYTES {
        return format!(
            "Diff omitted: {} changed bytes exceed the {} byte display limit.",
            detail_bytes, COMPUTED_DIFF_DETAIL_LIMIT_BYTES
        );
    }

    let mut diff = String::from("--- before\n+++ after\n");
    for hunk in &change_set.hunks {
        append_unified_hunk(&mut diff, hunk);
    }
    diff
}

fn append_unified_hunk(diff: &mut String, hunk: &ReviewHunk) {
    let old_count = diff_line_count(&hunk.before_text);
    let new_count = diff_line_count(&hunk.after_text);
    diff.push_str(&format!(
        "@@ -{} +{} @@\n",
        unified_range(hunk.old_range.start_line, old_count),
        unified_range(hunk.new_range.start_line, new_count)
    ));
    append_prefixed_lines(diff, '-', &hunk.before_text);
    append_prefixed_lines(diff, '+', &hunk.after_text);
}

fn unified_range(start_line: usize, line_count: usize) -> String {
    if line_count <= 1 {
        start_line.to_string()
    } else {
        format!("{start_line},{line_count}")
    }
}

fn append_prefixed_lines(diff: &mut String, marker: char, text: &str) {
    for line in text.split_inclusive('\n') {
        diff.push(marker);
        diff.push_str(line);
        if !line.ends_with('\n') {
            diff.push('\n');
        }
    }
}

fn build_hunks(source: &ChangeSource, before: &str, after: &str) -> Vec<ReviewHunk> {
    if before == after {
        return Vec::new();
    }

    let window = trim_common_line_affixes(before, after);

    if window.before_text.is_empty() && window.after_text.is_empty() {
        return Vec::new();
    }

    if window.before_text.len() + window.after_text.len() > REVIEW_DIFF_WINDOW_LIMIT_BYTES {
        let mut hunks = Vec::new();
        push_hunk(
            source,
            &mut hunks,
            window.before_start_byte,
            window.after_start_byte,
            window.before_start_line,
            window.after_start_line,
            window.before_end_byte,
            window.after_end_byte,
            window.before_start_line + diff_line_count(window.before_text),
            window.after_start_line + diff_line_count(window.after_text),
            window.before_text.to_string(),
            window.after_text.to_string(),
        );
        return hunks;
    }

    build_window_hunks(source, window)
}

fn build_window_hunks(source: &ChangeSource, window: DiffWindow<'_>) -> Vec<ReviewHunk> {
    let diff = TextDiff::from_lines(window.before_text, window.after_text);
    let mut hunks = Vec::new();
    let mut active = ActiveHunk::default();
    let mut before_offset = window.before_start_byte;
    let mut after_offset = window.after_start_byte;
    let mut before_line = window.before_start_line;
    let mut after_line = window.after_start_line;

    for change in diff.iter_all_changes() {
        let value = change.value();
        let line_count = diff_line_count(value);

        match change.tag() {
            ChangeTag::Equal => {
                finish_hunk(
                    &mut active,
                    source,
                    &mut hunks,
                    before_offset,
                    after_offset,
                    before_line,
                    after_line,
                );
                before_offset += value.len();
                after_offset += value.len();
                before_line += line_count;
                after_line += line_count;
            }
            ChangeTag::Delete => {
                active.start_if_needed(before_offset, after_offset, before_line, after_line);
                active.before_text.push_str(value);
                before_offset += value.len();
                before_line += line_count;
            }
            ChangeTag::Insert => {
                active.start_if_needed(before_offset, after_offset, before_line, after_line);
                active.after_text.push_str(value);
                after_offset += value.len();
                after_line += line_count;
            }
        }
    }

    finish_hunk(
        &mut active,
        source,
        &mut hunks,
        before_offset,
        after_offset,
        before_line,
        after_line,
    );
    hunks
}

fn finish_hunk(
    active: &mut ActiveHunk,
    source: &ChangeSource,
    hunks: &mut Vec<ReviewHunk>,
    before_end_byte: usize,
    after_end_byte: usize,
    before_end_line: usize,
    after_end_line: usize,
) {
    if !active.is_active() {
        return;
    }

    let before_text = std::mem::take(&mut active.before_text);
    let after_text = std::mem::take(&mut active.after_text);

    push_hunk(
        source,
        hunks,
        active.before_start_byte,
        active.after_start_byte,
        active.before_start_line,
        active.after_start_line,
        before_end_byte,
        after_end_byte,
        before_end_line,
        after_end_line,
        before_text,
        after_text,
    );
    active.reset();
}

#[allow(clippy::too_many_arguments)]
fn push_hunk(
    source: &ChangeSource,
    hunks: &mut Vec<ReviewHunk>,
    before_start_byte: usize,
    after_start_byte: usize,
    before_start_line: usize,
    after_start_line: usize,
    before_end_byte: usize,
    after_end_byte: usize,
    before_end_line: usize,
    after_end_line: usize,
    before_text: String,
    after_text: String,
) {
    if before_text.is_empty() && after_text.is_empty() {
        return;
    }

    let index = hunks.len();
    let old_range = TextRange {
        start_byte: before_start_byte,
        end_byte: before_end_byte,
        start_line: before_start_line,
        end_line: before_end_line,
    };
    let new_range = TextRange {
        start_byte: after_start_byte,
        end_byte: after_end_byte,
        start_line: after_start_line,
        end_line: after_end_line,
    };
    let kind = hunk_kind(&before_text, &after_text);
    let id = hunk_id(
        source,
        index,
        kind,
        old_range,
        new_range,
        &before_text,
        &after_text,
    );

    hunks.push(ReviewHunk {
        id,
        index,
        kind,
        old_range,
        new_range,
        before_text,
        after_text,
        heading_path: Vec::new(),
        summary: None,
    });
}

#[derive(Clone, Copy)]
struct DiffWindow<'a> {
    before_text: &'a str,
    after_text: &'a str,
    before_start_byte: usize,
    before_end_byte: usize,
    after_start_byte: usize,
    after_end_byte: usize,
    before_start_line: usize,
    after_start_line: usize,
}

#[derive(Clone, Copy)]
struct LineSpan<'a> {
    text: &'a str,
    start_byte: usize,
}

fn trim_common_line_affixes<'a>(before: &'a str, after: &'a str) -> DiffWindow<'a> {
    let before_lines = line_spans(before);
    let after_lines = line_spans(after);
    let shared_line_count = before_lines.len().min(after_lines.len());

    let mut prefix_line_count = 0;
    while prefix_line_count < shared_line_count
        && before_lines[prefix_line_count].text == after_lines[prefix_line_count].text
    {
        prefix_line_count += 1;
    }

    let mut suffix_line_count = 0;
    while suffix_line_count < before_lines.len().saturating_sub(prefix_line_count)
        && suffix_line_count < after_lines.len().saturating_sub(prefix_line_count)
    {
        let before_index = before_lines.len() - suffix_line_count - 1;
        let after_index = after_lines.len() - suffix_line_count - 1;

        if before_lines[before_index].text != after_lines[after_index].text {
            break;
        }

        suffix_line_count += 1;
    }

    let before_start_byte = before_lines
        .get(prefix_line_count)
        .map(|line| line.start_byte)
        .unwrap_or(before.len());
    let after_start_byte = after_lines
        .get(prefix_line_count)
        .map(|line| line.start_byte)
        .unwrap_or(after.len());
    let before_end_index = before_lines.len().saturating_sub(suffix_line_count);
    let after_end_index = after_lines.len().saturating_sub(suffix_line_count);
    let before_end_byte = before_lines
        .get(before_end_index)
        .map(|line| line.start_byte)
        .unwrap_or(before.len());
    let after_end_byte = after_lines
        .get(after_end_index)
        .map(|line| line.start_byte)
        .unwrap_or(after.len());

    DiffWindow {
        before_text: &before[before_start_byte..before_end_byte],
        after_text: &after[after_start_byte..after_end_byte],
        before_start_byte,
        before_end_byte,
        after_start_byte,
        after_end_byte,
        before_start_line: prefix_line_count + 1,
        after_start_line: prefix_line_count + 1,
    }
}

fn line_spans(text: &str) -> Vec<LineSpan<'_>> {
    let mut spans = Vec::new();
    let mut start_byte = 0;

    for line in text.split_inclusive('\n') {
        spans.push(LineSpan {
            text: line,
            start_byte,
        });
        start_byte += line.len();
    }

    spans
}

fn hunk_kind(before_text: &str, after_text: &str) -> HunkKind {
    match (before_text.is_empty(), after_text.is_empty()) {
        (true, false) => HunkKind::Insert,
        (false, true) => HunkKind::Delete,
        (false, false) => HunkKind::Replace,
        (true, true) => HunkKind::Replace,
    }
}

fn hunk_id(
    source: &ChangeSource,
    index: usize,
    kind: HunkKind,
    old_range: TextRange,
    new_range: TextRange,
    before_text: &str,
    after_text: &str,
) -> String {
    let seed = format!(
        "margent-review-hunk-v1\n{}\n{}\n{index}\n{kind:?}\n{}:{}:{}:{}\n{}:{}:{}:{}\n{}\n{}",
        source.kind,
        source.id.as_deref().unwrap_or(""),
        old_range.start_byte,
        old_range.end_byte,
        old_range.start_line,
        old_range.end_line,
        new_range.start_byte,
        new_range.end_byte,
        new_range.start_line,
        new_range.end_line,
        content_hash(before_text),
        content_hash(after_text)
    );
    format!("hunk_{}", short_hash(&seed))
}

fn change_set_id(
    document_id: &str,
    source: &ChangeSource,
    before_hash: &str,
    after_hash: &str,
) -> String {
    let seed = format!(
        "margent-review-change-set-v1\n{document_id}\n{}\n{}\n{before_hash}\n{after_hash}",
        source.kind,
        source.id.as_deref().unwrap_or("")
    );
    format!("change_set_{}", short_hash(&seed))
}

fn short_hash(value: &str) -> String {
    content_hash(value)
        .strip_prefix("sha256:")
        .expect("content_hash uses sha256 prefix")
        .chars()
        .take(24)
        .collect()
}

fn diff_line_count(value: &str) -> usize {
    if value.is_empty() {
        return 0;
    }

    let newline_count = value.bytes().filter(|byte| *byte == b'\n').count();
    if value.ends_with('\n') {
        newline_count
    } else {
        newline_count + 1
    }
}

fn validate_hunk_range(before: &str, hunk: &ReviewHunk) -> Result<(), String> {
    let range = hunk.old_range;
    if range.start_byte > range.end_byte || range.end_byte > before.len() {
        return Err(format!("Hunk {} has an invalid source range", hunk.id));
    }
    if !before.is_char_boundary(range.start_byte) || !before.is_char_boundary(range.end_byte) {
        return Err(format!(
            "Hunk {} source range is not on UTF-8 boundaries",
            hunk.id
        ));
    }
    if &before[range.start_byte..range.end_byte] != hunk.before_text.as_str() {
        return Err(format!("Hunk {} no longer matches before text", hunk.id));
    }
    Ok(())
}

#[derive(Default)]
struct ActiveHunk {
    active: bool,
    before_start_byte: usize,
    after_start_byte: usize,
    before_start_line: usize,
    after_start_line: usize,
    before_text: String,
    after_text: String,
}

impl ActiveHunk {
    fn is_active(&self) -> bool {
        self.active
    }

    fn start_if_needed(
        &mut self,
        before_start_byte: usize,
        after_start_byte: usize,
        before_start_line: usize,
        after_start_line: usize,
    ) {
        if self.active {
            return;
        }

        self.active = true;
        self.before_start_byte = before_start_byte;
        self.after_start_byte = after_start_byte;
        self.before_start_line = before_start_line;
        self.after_start_line = after_start_line;
    }

    fn reset(&mut self) {
        self.active = false;
        self.before_start_byte = 0;
        self.after_start_byte = 0;
        self.before_start_line = 0;
        self.after_start_line = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> ChangeSource {
        ChangeSource {
            kind: "proposal".into(),
            id: Some("proposal_1".into()),
        }
    }

    fn hunk_ids(change_set: &ReviewChangeSet) -> Vec<&str> {
        change_set
            .hunks
            .iter()
            .map(|hunk| hunk.id.as_str())
            .collect()
    }

    #[test]
    fn builds_insert_hunk() {
        let before = "Alpha\nCharlie\n";
        let after = "Alpha\nBravo\nCharlie\n";

        let change_set = build_review_change_set("doc_1", source(), before, after);

        assert_eq!(change_set.before_hash, content_hash(before));
        assert_eq!(change_set.after_hash, content_hash(after));
        assert_eq!(change_set.hunks.len(), 1);
        let hunk = &change_set.hunks[0];
        assert_eq!(hunk.kind, HunkKind::Insert);
        assert_eq!(hunk.before_text, "");
        assert_eq!(hunk.after_text, "Bravo\n");
        assert_eq!(
            hunk.old_range,
            TextRange {
                start_byte: "Alpha\n".len(),
                end_byte: "Alpha\n".len(),
                start_line: 2,
                end_line: 2,
            }
        );
    }

    #[test]
    fn builds_delete_hunk() {
        let before = "Alpha\nBravo\nCharlie\n";
        let after = "Alpha\nCharlie\n";

        let change_set = build_review_change_set("doc_1", source(), before, after);

        assert_eq!(change_set.hunks.len(), 1);
        let hunk = &change_set.hunks[0];
        assert_eq!(hunk.kind, HunkKind::Delete);
        assert_eq!(hunk.before_text, "Bravo\n");
        assert_eq!(hunk.after_text, "");
        assert_eq!(
            hunk.new_range,
            TextRange {
                start_byte: "Alpha\n".len(),
                end_byte: "Alpha\n".len(),
                start_line: 2,
                end_line: 2,
            }
        );
    }

    #[test]
    fn builds_replace_hunk() {
        let before = "Alpha\nBravo\nCharlie\n";
        let after = "Alpha\nBeta\nCharlie\n";

        let change_set = build_review_change_set("doc_1", source(), before, after);

        assert_eq!(change_set.hunks.len(), 1);
        let hunk = &change_set.hunks[0];
        assert_eq!(hunk.kind, HunkKind::Replace);
        assert_eq!(hunk.before_text, "Bravo\n");
        assert_eq!(hunk.after_text, "Beta\n");
    }

    #[test]
    fn builds_localized_hunk_for_large_repeated_document() {
        let repeated =
            "This is repeated markdown content that can confuse whole-document line diffing.\n";
        let prefix = repeated.repeat(4_000);
        let suffix = repeated.repeat(4_000);
        let before = format!("{prefix}Original paragraph that needs revising.\n{suffix}");
        let after = format!("{prefix}Revised paragraph after the revision.\n{suffix}");

        let change_set = build_review_change_set("doc_1", source(), &before, &after);

        assert_eq!(change_set.hunks.len(), 1);
        let hunk = &change_set.hunks[0];
        assert_eq!(
            hunk.before_text,
            "Original paragraph that needs revising.\n"
        );
        assert_eq!(hunk.after_text, "Revised paragraph after the revision.\n");
        assert_eq!(hunk.old_range.start_byte, prefix.len());
        assert_eq!(hunk.new_range.start_byte, prefix.len());
        assert_eq!(hunk.old_range.start_line, 4_001);
        assert_eq!(hunk.new_range.start_line, 4_001);
    }

    #[test]
    fn falls_back_to_single_hunk_for_large_changed_windows() {
        let before = "Before line with enough text to exceed the safe diff window.\n".repeat(2_000);
        let after = "After line with enough text to exceed the safe diff window.\n".repeat(2_000);

        let change_set = build_review_change_set("doc_1", source(), &before, &after);

        assert_eq!(change_set.hunks.len(), 1);
        let hunk = &change_set.hunks[0];
        assert_eq!(hunk.kind, HunkKind::Replace);
        assert_eq!(hunk.before_text, before);
        assert_eq!(hunk.after_text, after);
        assert_eq!(hunk.old_range.start_byte, 0);
        assert_eq!(hunk.new_range.start_byte, 0);
    }

    #[test]
    fn hunk_ids_are_stable_for_same_inputs() {
        let before = "One\nTwo\nThree\n";
        let after = "One\n2\nThree\nFour\n";

        let first = build_review_change_set("doc_1", source(), before, after);
        let second = build_review_change_set("doc_1", source(), before, after);

        assert_eq!(hunk_ids(&first), hunk_ids(&second));
        assert_eq!(first.id, second.id);
    }

    #[test]
    fn apply_no_hunks_returns_exact_before_text() {
        let before = "One\nTwo\n";
        let after = "One\nTwo\nThree\n";
        let change_set = build_review_change_set("doc_1", source(), before, after);

        let applied =
            apply_selected_hunks(before, &change_set, [] as [&str; 0]).expect("apply no hunks");

        assert_eq!(applied, before);
    }

    #[test]
    fn apply_all_hunks_returns_exact_after_text() {
        let before = "One\nTwo\nThree\n";
        let after = "Zero\nOne\n2\nThree\nFour\n";
        let change_set = build_review_change_set("doc_1", source(), before, after);
        let selected = hunk_ids(&change_set);

        let applied = apply_selected_hunks(before, &change_set, selected).expect("apply all hunks");

        assert_eq!(applied, after);
    }

    #[test]
    fn apply_subset_is_deterministic() {
        let before = "One\nTwo\nThree\nFour\n";
        let after = "Zero\nOne\n2\nThree\nFour\nFive\n";
        let change_set = build_review_change_set("doc_1", source(), before, after);
        assert_eq!(change_set.hunks.len(), 3);
        let selected = vec![
            change_set.hunks[2].id.as_str(),
            change_set.hunks[0].id.as_str(),
        ];

        let first =
            apply_selected_hunks(before, &change_set, selected.clone()).expect("apply subset");
        let second = apply_selected_hunks(before, &change_set, selected).expect("apply subset");

        assert_eq!(first, "Zero\nOne\nTwo\nThree\nFour\nFive\n");
        assert_eq!(first, second);
    }

    #[test]
    fn apply_rejects_unknown_hunk_ids() {
        let before = "One\nTwo\n";
        let after = "One\n2\n";
        let change_set = build_review_change_set("doc_1", source(), before, after);

        let error = apply_selected_hunks(before, &change_set, ["hunk_missing"])
            .expect_err("unknown hunk should fail");

        assert!(error.contains("Unknown hunk id: hunk_missing"));
    }

    #[test]
    fn unicode_text_uses_valid_byte_ranges_and_applies_cleanly() {
        let before = "Café\nnaïve\n東京\n";
        let after = "Café\nnaïve idea\n東京\n雪\n";
        let change_set = build_review_change_set("doc_1", source(), before, after);
        assert_eq!(change_set.hunks.len(), 2);

        for hunk in &change_set.hunks {
            assert!(before.is_char_boundary(hunk.old_range.start_byte));
            assert!(before.is_char_boundary(hunk.old_range.end_byte));
            assert!(after.is_char_boundary(hunk.new_range.start_byte));
            assert!(after.is_char_boundary(hunk.new_range.end_byte));
        }

        let selected = hunk_ids(&change_set);
        let applied =
            apply_selected_hunks(before, &change_set, selected).expect("apply unicode hunks");

        assert_eq!(applied, after);
    }

    #[test]
    fn unified_diff_is_small_and_localized_for_large_repeated_documents() {
        let repeated =
            "This is repeated markdown content that should not enter the rendered diff.\n";
        let prefix = repeated.repeat(4_000);
        let suffix = repeated.repeat(4_000);
        let before = format!("{prefix}Original paragraph that needs revising.\n{suffix}");
        let after = format!("{prefix}Revised paragraph after the revision.\n{suffix}");

        let diff = compute_unified_diff(&before, &after);

        assert!(diff.contains("@@ -4001 +4001 @@"));
        assert!(diff.contains("-Original paragraph that needs revising."));
        assert!(diff.contains("+Revised paragraph after the revision."));
        assert!(diff.len() < 512);
    }

    #[test]
    fn unified_diff_omits_detail_for_large_changed_windows() {
        let before = "Before line with enough text to exceed the safe diff window.\n".repeat(2_000);
        let after = "After line with enough text to exceed the safe diff window.\n".repeat(2_000);

        let diff = compute_unified_diff(&before, &after);

        assert!(diff.starts_with("Diff omitted:"));
    }
}
