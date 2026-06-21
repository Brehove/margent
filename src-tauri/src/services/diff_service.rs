use margent_core::change_set::{build_review_change_set, ChangeSource, ReviewHunk};

const COMPUTED_DIFF_DETAIL_LIMIT_BYTES: usize = 128_000;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_small_localized_diff_for_large_repeated_documents() {
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
    fn omits_detail_for_large_changed_windows() {
        let before = "Before line with enough text to exceed the safe diff window.\n".repeat(2_000);
        let after = "After line with enough text to exceed the safe diff window.\n".repeat(2_000);

        let diff = compute_unified_diff(&before, &after);

        assert!(diff.starts_with("Diff omitted:"));
    }
}
