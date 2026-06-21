use crate::models::search::ProjectSearchResponse;
use crate::services::search_service;

#[tauri::command]
pub async fn search_workspace(
    workspace_root: String,
    query: String,
    mode: Option<String>,
    case_sensitive: Option<bool>,
) -> Result<ProjectSearchResponse, String> {
    super::run_blocking("search workspace", move || {
        search_service::search_workspace(
            &workspace_root,
            &query,
            mode.as_deref().unwrap_or("literal"),
            case_sensitive.unwrap_or(false),
        )
    })
    .await
}
