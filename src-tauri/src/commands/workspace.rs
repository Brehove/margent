use crate::models::document::DocumentPayload;
use crate::models::workspace::{WorkspaceOpenRequest, WorkspaceSnapshot};
use crate::services::{open_request_service::PendingOpenRequestQueue, workspace_service};
use tauri::State;

#[tauri::command]
pub fn open_workspace(path: String) -> Result<WorkspaceSnapshot, String> {
    workspace_service::open_workspace(&path)
}

#[tauri::command]
pub fn list_review_passes(
    workspace_root: String,
) -> Result<Vec<margent_core::review_context::ReviewPassSummary>, String> {
    margent_core::review_context::list_review_passes(std::path::Path::new(&workspace_root))
}

#[tauri::command]
pub fn read_document(
    workspace_root: String,
    relative_path: String,
) -> Result<DocumentPayload, String> {
    workspace_service::read_document(&workspace_root, &relative_path)
}

#[tauri::command]
pub fn create_markdown_file(
    workspace_root: String,
    relative_path: String,
    content: Option<String>,
) -> Result<DocumentPayload, String> {
    workspace_service::create_markdown_file(&workspace_root, &relative_path, content.as_deref())
}

#[tauri::command]
pub fn rename_markdown_file(
    workspace_root: String,
    from_relative_path: String,
    to_relative_path: String,
) -> Result<DocumentPayload, String> {
    workspace_service::rename_markdown_file(&workspace_root, &from_relative_path, &to_relative_path)
}

#[tauri::command]
pub fn delete_markdown_file(
    workspace_root: String,
    relative_path: String,
) -> Result<WorkspaceSnapshot, String> {
    workspace_service::delete_markdown_file(&workspace_root, &relative_path)
}

#[tauri::command]
pub fn reveal_markdown_file(workspace_root: String, relative_path: String) -> Result<(), String> {
    workspace_service::reveal_markdown_file(&workspace_root, &relative_path)
}

#[tauri::command]
pub fn check_document_update(
    workspace_root: String,
    relative_path: String,
    known_content_hash: String,
) -> Result<Option<DocumentPayload>, String> {
    workspace_service::check_document_update(&workspace_root, &relative_path, &known_content_hash)
}

#[tauri::command]
pub fn save_document(
    workspace_root: String,
    relative_path: String,
    content: String,
) -> Result<DocumentPayload, String> {
    workspace_service::save_document(&workspace_root, &relative_path, &content)
}

#[tauri::command]
pub fn import_asset(
    workspace_root: String,
    suggested_name: String,
    bytes: Vec<u8>,
) -> Result<crate::models::workspace::AssetImportResult, String> {
    workspace_service::import_asset(&workspace_root, &suggested_name, bytes)
}

#[tauri::command]
pub fn take_pending_open_requests(
    queue: State<'_, PendingOpenRequestQueue>,
) -> Result<Vec<WorkspaceOpenRequest>, String> {
    Ok(queue.take_all())
}
