use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResponse {
    pub case_sensitive: bool,
    pub mode: String,
    pub query: String,
    pub results: Vec<ProjectSearchResult>,
    pub searched_files: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResult {
    pub after_context: Option<String>,
    pub before_context: Option<String>,
    pub column: usize,
    pub display_name: String,
    pub document_id: String,
    pub line: usize,
    pub line_text: String,
    pub match_end_column: usize,
    pub match_start_column: usize,
    pub match_text: String,
    pub relative_path: String,
}
