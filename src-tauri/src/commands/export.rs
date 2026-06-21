use crate::models::export::{DocumentExportResult, ExportFormat};
use crate::services::export_service;

#[tauri::command]
pub async fn export_document(
    workspace_root: String,
    relative_path: String,
    format: ExportFormat,
    google_doc: Option<bool>,
) -> Result<DocumentExportResult, String> {
    super::run_blocking("export document", move || {
        export_service::export_document(
            &workspace_root,
            &relative_path,
            format,
            google_doc.unwrap_or(false),
        )
    })
    .await
}
