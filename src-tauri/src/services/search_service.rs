use std::fs;
use std::path::Path;

use regex::RegexBuilder;

use crate::models::search::{ProjectSearchResponse, ProjectSearchResult};

use super::file_service;

const MAX_SEARCH_RESULTS: usize = 500;

pub fn search_workspace(
    workspace_root: &str,
    query: &str,
    mode: &str,
    case_sensitive: bool,
) -> Result<ProjectSearchResponse, String> {
    let normalized_mode = normalize_search_mode(mode)?;
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(ProjectSearchResponse {
            case_sensitive,
            mode: normalized_mode.to_string(),
            query: trimmed_query.to_string(),
            results: Vec::new(),
            searched_files: 0,
            truncated: false,
        });
    }

    let root = Path::new(workspace_root).canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace root {}: {error}",
            workspace_root
        )
    })?;
    let files = file_service::list_markdown_files(&root)?;
    let pattern = if normalized_mode == "literal" {
        regex::escape(trimmed_query)
    } else {
        trimmed_query.to_string()
    };
    let matcher = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| format!("Invalid regular expression: {error}"))?;

    let mut results = Vec::new();
    let mut truncated = false;

    'files: for file in &files {
        let content = fs::read_to_string(file)
            .map_err(|error| format!("Unable to read {}: {error}", file.display()))?;
        let relative_path = file_service::relative_path_string(&root, file)?;
        let document_id = file_service::document_id(&relative_path);
        let display_name = file
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&relative_path)
            .to_string();
        let lines: Vec<&str> = content.lines().collect();

        for (line_index, raw_line) in lines.iter().enumerate() {
            let line_text = raw_line.trim_end_matches('\r');
            for hit in matcher.find_iter(line_text) {
                if hit.start() == hit.end() {
                    continue;
                }

                if results.len() >= MAX_SEARCH_RESULTS {
                    truncated = true;
                    break 'files;
                }

                let before_context = line_index
                    .checked_sub(1)
                    .and_then(|index| lines.get(index))
                    .map(|line| line.trim_end_matches('\r').to_string());
                let after_context = lines
                    .get(line_index + 1)
                    .map(|line| line.trim_end_matches('\r').to_string());
                let match_start_column = utf8_byte_to_one_based_column(line_text, hit.start());
                let match_end_column = utf8_byte_to_one_based_column(line_text, hit.end());

                results.push(ProjectSearchResult {
                    after_context,
                    before_context,
                    column: match_start_column,
                    display_name: display_name.clone(),
                    document_id: document_id.clone(),
                    line: line_index + 1,
                    line_text: line_text.to_string(),
                    match_end_column,
                    match_start_column,
                    match_text: hit.as_str().to_string(),
                    relative_path: relative_path.clone(),
                });
            }
        }
    }

    Ok(ProjectSearchResponse {
        case_sensitive,
        mode: normalized_mode.to_string(),
        query: trimmed_query.to_string(),
        results,
        searched_files: files.len(),
        truncated,
    })
}

fn normalize_search_mode(mode: &str) -> Result<&'static str, String> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "" | "literal" => Ok("literal"),
        "regex" => Ok("regex"),
        _ => Err("Search mode must be literal or regex.".into()),
    }
}

fn utf8_byte_to_one_based_column(line: &str, byte_index: usize) -> usize {
    line[..byte_index].chars().count() + 1
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::search_workspace;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("margent-{label}-{nonce}"))
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn literal_search_uses_workspace_markdown_scan_policy_and_context() {
        let root = unique_temp_dir("project-search-literal");
        write_file(
            &root.join("draft.md"),
            "# Draft\nThe AI era needs judgment.\nFinal line.\n",
        );
        write_file(&root.join(".hidden/note.markdown"), "Hidden AI era note.\n");
        write_file(&root.join(".mdreview/ignored.md"), "AI era sidecar.\n");
        write_file(
            &root.join("node_modules/ignored.md"),
            "AI era dependency.\n",
        );
        write_file(&root.join("plain.txt"), "AI era text file.\n");

        let response =
            search_workspace(root.to_str().expect("root str"), "ai era", "literal", false)
                .expect("search workspace");

        assert_eq!(response.searched_files, 2);
        assert_eq!(
            response
                .results
                .iter()
                .map(|result| result.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![".hidden/note.markdown", "draft.md"]
        );
        let draft = response
            .results
            .iter()
            .find(|result| result.relative_path == "draft.md")
            .expect("draft result");
        assert_eq!(draft.line, 2);
        assert_eq!(draft.column, 5);
        assert_eq!(draft.before_context.as_deref(), Some("# Draft"));
        assert_eq!(draft.after_context.as_deref(), Some("Final line."));

        fs::remove_dir_all(&root).expect("remove temp root");
    }

    #[test]
    fn regex_search_supports_patterns_and_case_sensitive_matching() {
        let root = unique_temp_dir("project-search-regex");
        write_file(&root.join("draft.md"), "AI era\nai   era\nA1 era\n");

        let insensitive = search_workspace(
            root.to_str().expect("root str"),
            r"ai\s+era",
            "regex",
            false,
        )
        .expect("case-insensitive regex search");
        assert_eq!(insensitive.results.len(), 2);

        let sensitive =
            search_workspace(root.to_str().expect("root str"), r"AI\s+era", "regex", true)
                .expect("case-sensitive regex search");
        assert_eq!(sensitive.results.len(), 1);
        assert_eq!(sensitive.results[0].line, 1);

        fs::remove_dir_all(&root).expect("remove temp root");
    }

    #[test]
    fn invalid_regex_returns_a_clear_error() {
        let root = unique_temp_dir("project-search-invalid-regex");
        write_file(&root.join("draft.md"), "AI era\n");

        let error = search_workspace(root.to_str().expect("root str"), "(", "regex", false)
            .expect_err("invalid regex");
        assert!(error.contains("Invalid regular expression"));

        fs::remove_dir_all(&root).expect("remove temp root");
    }
}
