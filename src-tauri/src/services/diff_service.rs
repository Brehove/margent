pub use margent_core::change_set::compute_unified_diff;

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
