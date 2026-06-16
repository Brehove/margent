use serde::{Deserialize, Serialize};

pub use margent_core::export::ExportFormat;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExportResult {
    pub document_relative_path: String,
    pub format: ExportFormat,
    pub google_doc_url: Option<String>,
    pub output_path: Option<String>,
}
