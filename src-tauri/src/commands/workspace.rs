use crate::models::document::{DocumentPayload, DocumentVersion, SaveDocumentIfCurrentResult};
use crate::models::workspace::{WorkspaceOpenRequest, WorkspaceSnapshot};
use crate::services::{open_request_service::PendingOpenRequestQueue, workspace_service};
use tauri::State;

#[tauri::command]
pub async fn open_workspace(path: String) -> Result<WorkspaceSnapshot, String> {
    super::run_blocking("open workspace", move || {
        workspace_service::open_workspace(&path)
    })
    .await
}

#[tauri::command]
pub async fn list_review_passes(
    workspace_root: String,
) -> Result<Vec<margent_core::review_context::ReviewPassSummary>, String> {
    super::run_blocking("list review passes", move || {
        margent_core::review_context::list_review_passes(std::path::Path::new(&workspace_root))
    })
    .await
}

#[tauri::command]
pub async fn read_document(
    workspace_root: String,
    relative_path: String,
) -> Result<DocumentPayload, String> {
    super::run_blocking("read document", move || {
        workspace_service::read_document(&workspace_root, &relative_path)
    })
    .await
}

#[tauri::command]
pub async fn create_markdown_file(
    workspace_root: String,
    relative_path: String,
    content: Option<String>,
) -> Result<DocumentPayload, String> {
    super::run_blocking("create markdown file", move || {
        workspace_service::create_markdown_file(&workspace_root, &relative_path, content.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn rename_markdown_file(
    workspace_root: String,
    from_relative_path: String,
    to_relative_path: String,
) -> Result<DocumentPayload, String> {
    super::run_blocking("rename markdown file", move || {
        workspace_service::rename_markdown_file(
            &workspace_root,
            &from_relative_path,
            &to_relative_path,
        )
    })
    .await
}

#[tauri::command]
pub async fn delete_markdown_file(
    workspace_root: String,
    relative_path: String,
) -> Result<WorkspaceSnapshot, String> {
    super::run_blocking("delete markdown file", move || {
        workspace_service::delete_markdown_file(&workspace_root, &relative_path)
    })
    .await
}

#[tauri::command]
pub async fn reveal_markdown_file(
    workspace_root: String,
    relative_path: String,
) -> Result<(), String> {
    super::run_blocking("reveal markdown file", move || {
        workspace_service::reveal_markdown_file(&workspace_root, &relative_path)
    })
    .await
}

#[tauri::command]
pub async fn check_document_update(
    workspace_root: String,
    relative_path: String,
    known_content_hash: String,
) -> Result<Option<DocumentPayload>, String> {
    super::run_blocking("check document update", move || {
        workspace_service::check_document_update(
            &workspace_root,
            &relative_path,
            &known_content_hash,
        )
    })
    .await
}

#[tauri::command]
pub async fn save_document(
    workspace_root: String,
    relative_path: String,
    content: String,
) -> Result<DocumentPayload, String> {
    super::run_blocking("save document", move || {
        workspace_service::save_document(&workspace_root, &relative_path, &content)
    })
    .await
}

#[tauri::command]
pub async fn save_document_if_current(
    workspace_root: String,
    relative_path: String,
    content: String,
    expected_version: DocumentVersion,
    operation_id: String,
) -> Result<SaveDocumentIfCurrentResult, String> {
    super::run_blocking("save document if current", move || {
        workspace_service::save_document_if_current(
            &workspace_root,
            &relative_path,
            &content,
            &expected_version,
            &operation_id,
        )
    })
    .await
}

#[tauri::command]
pub async fn import_asset(
    workspace_root: String,
    suggested_name: String,
    bytes: Vec<u8>,
) -> Result<crate::models::workspace::AssetImportResult, String> {
    super::run_blocking("import asset", move || {
        workspace_service::import_asset(&workspace_root, &suggested_name, bytes)
    })
    .await
}

#[tauri::command]
pub fn take_pending_open_requests(
    queue: State<'_, PendingOpenRequestQueue>,
) -> Result<Vec<WorkspaceOpenRequest>, String> {
    Ok(queue.take_all())
}
