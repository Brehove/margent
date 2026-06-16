use crate::models::export::{DocumentExportResult, ExportFormat};
use crate::services::export_service;

#[tauri::command]
pub fn export_document(
    workspace_root: String,
    relative_path: String,
    format: ExportFormat,
    google_doc: Option<bool>,
) -> Result<DocumentExportResult, String> {
    export_service::export_document(
        &workspace_root,
        &relative_path,
        format,
        google_doc.unwrap_or(false),
    )
}
