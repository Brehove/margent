use std::path::Path;

use margent_core::export as core_export;

use crate::models::document::{DocumentPayload, DocumentRecord};
use crate::models::export::{DocumentExportResult, ExportFormat};

use super::workspace_service;

pub fn export_document(
    workspace_root: &str,
    relative_path: &str,
    format: ExportFormat,
    google_doc: bool,
) -> Result<DocumentExportResult, String> {
    let document = workspace_service::read_document(workspace_root, relative_path)?;
    let record = document_record(&document);
    let root = Path::new(workspace_root);

    if google_doc {
        let result =
            core_export::export_google_doc(root, &record, &document.content, Some(format), None)?;
        return Ok(DocumentExportResult {
            document_relative_path: record.relative_path,
            format: result.source_format,
            google_doc_url: Some(result.url),
            output_path: None,
        });
    }

    let result = core_export::export_file(root, &record, &document.content, format, None)?;
    Ok(DocumentExportResult {
        document_relative_path: record.relative_path,
        format: result.format,
        google_doc_url: None,
        output_path: Some(result.output_path.to_string_lossy().to_string()),
    })
}

fn document_record(document: &DocumentPayload) -> DocumentRecord {
    DocumentRecord {
        schema_version: document.schema_version,
        id: document.id.clone(),
        relative_path: document.relative_path.clone(),
        display_name: document.display_name.clone(),
        created_at: document.created_at.clone(),
        updated_at: document.updated_at.clone(),
        current_content_hash: document.current_content_hash.clone(),
        last_known_line_ending: document.last_known_line_ending.clone(),
        frontmatter_mode: document.frontmatter_mode.clone(),
        word_count: document.word_count,
        heading_index: document.heading_index.clone(),
    }
}
