use std::path::Path;

use clap::ValueEnum;
use margent_core::document::DocumentRecord;
use serde::Serialize;

pub use margent_core::export::{FileExportResult, GoogleDocExportResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Html,
    Pdf,
    Docx,
}

pub fn export_file(
    root: &Path,
    document: &DocumentRecord,
    content: &str,
    format: ExportFormat,
    output: Option<&Path>,
) -> Result<FileExportResult, String> {
    margent_core::export::export_file(root, document, content, core_format(format), output)
}

pub fn export_google_doc(
    root: &Path,
    document: &DocumentRecord,
    content: &str,
    preferred_format: Option<ExportFormat>,
    output: Option<&Path>,
) -> Result<GoogleDocExportResult, String> {
    margent_core::export::export_google_doc(
        root,
        document,
        content,
        preferred_format.map(core_format),
        output,
    )
}

pub fn format_from_path(path: &Path) -> Option<ExportFormat> {
    margent_core::export::format_from_path(path).and_then(cli_format)
}

fn core_format(format: ExportFormat) -> margent_core::export::ExportFormat {
    match format {
        ExportFormat::Html => margent_core::export::ExportFormat::Html,
        ExportFormat::Pdf => margent_core::export::ExportFormat::Pdf,
        ExportFormat::Docx => margent_core::export::ExportFormat::Docx,
    }
}

fn cli_format(format: margent_core::export::ExportFormat) -> Option<ExportFormat> {
    match format {
        margent_core::export::ExportFormat::Html => Some(ExportFormat::Html),
        margent_core::export::ExportFormat::Pdf => Some(ExportFormat::Pdf),
        margent_core::export::ExportFormat::Docx => Some(ExportFormat::Docx),
    }
}
