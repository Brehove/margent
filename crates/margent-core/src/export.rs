use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::document::DocumentRecord;
use crate::id::new_id;
use crate::io::write_string_atomic;

const GOOGLE_DOC_MIME_TYPE: &str = "application/vnd.google-apps.document";
const MAX_INLINE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Html,
    Pdf,
    Docx,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Html => "HTML",
            Self::Pdf => "PDF",
            Self::Docx => "DOCX",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileExportResult {
    pub format: ExportFormat,
    pub output_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDocExportResult {
    pub id: String,
    pub name: Option<String>,
    pub url: String,
    pub mime_type: Option<String>,
    pub source_format: ExportFormat,
    pub intermediate_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GwsCreatedFile {
    id: Option<String>,
    name: Option<String>,
    mime_type: Option<String>,
    web_view_link: Option<String>,
}

pub fn export_file(
    root: &Path,
    document: &DocumentRecord,
    content: &str,
    format: ExportFormat,
    output: Option<&Path>,
) -> Result<FileExportResult, String> {
    match format {
        ExportFormat::Html => {
            let output_path = output_path_for(root, document, output, ExportFormat::Html)?;
            write_html_export(root, document, content, &output_path)?;
            Ok(FileExportResult {
                format,
                output_path,
            })
        }
        ExportFormat::Docx => {
            let pandoc = find_pandoc().ok_or_else(pandoc_missing_error)?;
            let output_path = output_path_for(root, document, output, ExportFormat::Docx)?;
            write_docx_export(root, document, &output_path, &pandoc)?;
            Ok(FileExportResult {
                format,
                output_path,
            })
        }
        ExportFormat::Pdf => Err(pdf_unavailable_error(document)),
    }
}

pub fn export_google_doc(
    root: &Path,
    document: &DocumentRecord,
    content: &str,
    preferred_format: Option<ExportFormat>,
    output: Option<&Path>,
) -> Result<GoogleDocExportResult, String> {
    let gws = find_gws().ok_or_else(gws_missing_error)?;
    let title = document_title(document, content);
    let pandoc = find_pandoc();
    let inferred_format = preferred_format.or_else(|| output.and_then(format_from_path));
    let source_format = match inferred_format {
        Some(ExportFormat::Pdf) => return Err(pdf_unavailable_error(document)),
        Some(ExportFormat::Docx) => {
            if pandoc.is_none() {
                return Err(pandoc_missing_error());
            }
            ExportFormat::Docx
        }
        Some(ExportFormat::Html) => ExportFormat::Html,
        // Default to HTML: Google's HTML conversion produces native-looking
        // tables, no heading bookmark anchors, and images arrive inlined as
        // data URIs. DOCX remains available as an explicit option.
        None => ExportFormat::Html,
    };
    let intermediate_path = match output {
        Some(path) => output_path_for(root, document, Some(path), source_format)?,
        None => temporary_output_path(document, source_format)?,
    };

    match source_format {
        ExportFormat::Docx => {
            let pandoc = pandoc.expect("checked above");
            write_docx_export(root, document, &intermediate_path, &pandoc)?;
        }
        ExportFormat::Html => write_html_export(root, document, content, &intermediate_path)?,
        ExportFormat::Pdf => unreachable!("Google Docs export never uses PDF"),
    }

    let upload = upload_google_doc(&gws, &intermediate_path, &title, source_format);
    if output.is_none() {
        let _ = fs::remove_file(&intermediate_path);
    }
    let mut upload = upload?;
    if output.is_none() {
        upload.intermediate_path = None;
    }
    Ok(upload)
}

pub fn output_path_for(
    root: &Path,
    document: &DocumentRecord,
    output: Option<&Path>,
    format: ExportFormat,
) -> Result<PathBuf, String> {
    let path = match output {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        Some(path) => root.join(path),
        None => root
            .join(&document.relative_path)
            .with_extension(format.extension()),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create export directory {}: {error}",
                parent.display()
            )
        })?;
    }
    Ok(path)
}

pub fn format_from_path(path: &Path) -> Option<ExportFormat> {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm") => Some(ExportFormat::Html),
        Some("docx") => Some(ExportFormat::Docx),
        Some("pdf") => Some(ExportFormat::Pdf),
        _ => None,
    }
}

pub fn write_html_export(
    root: &Path,
    document: &DocumentRecord,
    content: &str,
    output_path: &Path,
) -> Result<(), String> {
    let document_dir = root.join(&document.relative_path);
    let document_dir = document_dir.parent();
    let html = render_standalone_html(document, content, document_dir);
    write_string_atomic(output_path, &html)
}

pub fn write_docx_export(
    root: &Path,
    document: &DocumentRecord,
    output_path: &Path,
    pandoc: &Path,
) -> Result<(), String> {
    let source_path = root.join(&document.relative_path);
    let source_dir = source_path.parent().ok_or_else(|| {
        format!(
            "Unable to derive parent directory for {}",
            source_path.display()
        )
    })?;
    let source_file = source_path
        .file_name()
        .ok_or_else(|| format!("Unable to derive file name for {}", source_path.display()))?;
    let resource_path = format!("{}:{}", source_dir.display(), root.display());
    let output = Command::new(pandoc)
        .current_dir(source_dir)
        .arg(source_file)
        .args([
            "--from",
            "markdown+pipe_tables+footnotes+task_lists+strikeout+yaml_metadata_block-auto_identifiers",
            "--to",
            "docx",
            "--standalone",
            "--resource-path",
            &resource_path,
            "--output",
        ])
        .arg(output_path)
        .output()
        .map_err(|error| format!("Unable to run pandoc at {}: {error}", pandoc.display()))?;

    if !output.status.success() {
        return Err(format!(
            "pandoc could not export DOCX: {}",
            command_output_detail(&output)
        ));
    }

    Ok(())
}

pub fn render_standalone_html(
    document: &DocumentRecord,
    markdown: &str,
    document_dir: Option<&Path>,
) -> String {
    let title = document_title(document, markdown);
    let markdown_body = strip_yaml_frontmatter(markdown);
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);

    let parser = Parser::new_ext(markdown_body, options).map(|event| match event {
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            let inlined = inline_image_data_uri(document_dir, dest_url.as_ref());
            Event::Start(Tag::Image {
                link_type,
                dest_url: inlined.map_or(dest_url, CowStr::from),
                title,
                id,
            })
        }
        other => other,
    });
    let mut body = String::new();
    html::push_html(&mut body, parser);

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{}</title>
<style>
:root {{
  color-scheme: light;
  --margent-paper: #fffdf8;
  --margent-ink: #17110c;
  --margent-muted: #66584a;
  --margent-rule: #d7c7a2;
  --margent-link: #173c3b;
}}
* {{ box-sizing: border-box; }}
html {{ background: #f7f0df; }}
body {{
  margin: 0;
  color: var(--margent-ink);
  background: var(--margent-paper);
  font: 18px/1.65 ui-serif, Georgia, Cambria, "Times New Roman", serif;
}}
main.margent-export {{
  max-width: 760px;
  margin: 0 auto;
  padding: 56px 28px 72px;
}}
h1, h2, h3, h4, h5, h6 {{
  margin: 1.8em 0 0.45em;
  line-height: 1.2;
}}
h1 {{ font-size: 2.25rem; }}
h2 {{ font-size: 1.65rem; border-bottom: 1px solid var(--margent-rule); padding-bottom: 0.2em; }}
h3 {{ font-size: 1.25rem; }}
p, ul, ol, blockquote, pre, table {{ margin: 0 0 1.05em; }}
a {{ color: var(--margent-link); }}
blockquote {{
  border-left: 3px solid var(--margent-rule);
  color: var(--margent-muted);
  padding-left: 1em;
}}
code, pre {{
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}}
code {{ background: #f1e8d6; padding: 0.08em 0.25em; }}
pre {{ background: #f7f0df; overflow-x: auto; padding: 1em; }}
pre code {{ background: transparent; padding: 0; }}
table {{ width: 100%; border-collapse: collapse; font-size: 0.95em; }}
th, td {{ border: 1px solid var(--margent-rule); padding: 0.45em 0.6em; text-align: left; vertical-align: top; }}
th {{ background: #f3ead8; }}
img {{ max-width: 100%; height: auto; }}
hr {{ border: 0; border-top: 1px solid var(--margent-rule); margin: 2em 0; }}
@media print {{
  html, body {{ background: #fff; }}
  main.margent-export {{ max-width: none; padding: 0; }}
}}
</style>
</head>
<body>
<main class="margent-export">
{}
</main>
</body>
</html>
"#,
        escape_html_text(&title),
        body
    )
}

pub fn upload_google_doc(
    gws: &Path,
    upload_path: &Path,
    title: &str,
    source_format: ExportFormat,
) -> Result<GoogleDocExportResult, String> {
    let upload_name = format!("{title}.{}", source_format.extension());
    let upload_metadata = json!({ "name": upload_name }).to_string();
    let upload_params = json!({
        "fields": "id,name,mimeType,webViewLink",
        "supportsAllDrives": true,
    })
    .to_string();
    let upload_output = Command::new(gws)
        .args(["drive", "files", "create"])
        .args(["--json", &upload_metadata])
        .args(["--params", &upload_params])
        .arg("--upload")
        .arg(upload_path)
        .arg("--format")
        .arg("json")
        .output()
        .map_err(|error| format!("Unable to run gws at {}: {error}", gws.display()))?;

    if !upload_output.status.success() {
        return Err(format!(
            "gws could not upload the Google Doc: {}",
            command_output_detail(&upload_output)
        ));
    }

    let uploaded_file = parse_gws_file(&String::from_utf8_lossy(&upload_output.stdout))?;
    let uploaded_file_id = uploaded_file
        .id
        .ok_or_else(|| "gws upload response did not include a file id.".to_string())?;
    let copy_metadata = json!({
        "name": title,
        "mimeType": GOOGLE_DOC_MIME_TYPE,
    })
    .to_string();
    let copy_params = json!({
        "fileId": uploaded_file_id,
        "fields": "id,name,mimeType,webViewLink",
        "supportsAllDrives": true,
    })
    .to_string();
    let copy_output = Command::new(gws)
        .args(["drive", "files", "copy"])
        .args(["--json", &copy_metadata])
        .args(["--params", &copy_params])
        .arg("--format")
        .arg("json")
        .output()
        .map_err(|error| format!("Unable to run gws at {}: {error}", gws.display()))?;

    let _ = Command::new(gws)
        .args(["drive", "files", "delete"])
        .args([
            "--params",
            &json!({ "fileId": uploaded_file_id, "supportsAllDrives": true }).to_string(),
        ])
        .arg("--format")
        .arg("json")
        .output();

    if !copy_output.status.success() {
        return Err(format!(
            "gws could not convert the Google Doc: {}",
            command_output_detail(&copy_output)
        ));
    }

    parse_gws_created_file(
        &String::from_utf8_lossy(&copy_output.stdout),
        source_format,
        Some(upload_path.to_path_buf()),
    )
}

pub fn parse_gws_created_file(
    stdout: &str,
    source_format: ExportFormat,
    intermediate_path: Option<PathBuf>,
) -> Result<GoogleDocExportResult, String> {
    let created = parse_gws_file(stdout)?;
    let id = created
        .id
        .ok_or_else(|| "gws response did not include a file id.".to_string())?;
    let url = created
        .web_view_link
        .unwrap_or_else(|| format!("https://docs.google.com/document/d/{id}/edit"));
    Ok(GoogleDocExportResult {
        id,
        name: created.name,
        url,
        mime_type: created.mime_type,
        source_format,
        intermediate_path,
    })
}

pub fn document_title(document: &DocumentRecord, markdown: &str) -> String {
    for line in strip_yaml_frontmatter(markdown).lines() {
        let trimmed = line.trim_start();
        let depth = trimmed.chars().take_while(|ch| *ch == '#').count();
        if !(1..=6).contains(&depth) {
            continue;
        }
        let rest = trimmed[depth..].trim();
        if rest.is_empty() {
            continue;
        }
        let title = rest.trim_end_matches('#').trim();
        if !title.is_empty() {
            return title.to_string();
        }
    }
    Path::new(&document.display_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or(&document.display_name)
        .to_string()
}

pub fn pdf_unavailable_error(document: &DocumentRecord) -> String {
    format!(
        "PDF export is handled by the Margent desktop print path for {}. Open the document in the Margent desktop app and use Cmd+P / File > Print to save it as PDF.",
        document.relative_path
    )
}

pub fn pandoc_missing_error() -> String {
    "DOCX export requires pandoc on PATH. Install pandoc, or export HTML instead.".into()
}

pub fn gws_missing_error() -> String {
    "Google Docs export requires the gws CLI. Install and authenticate gws, then ensure `gws` is on PATH; Margent also checks ~/.cargo/bin/gws.".into()
}

pub fn find_pandoc() -> Option<PathBuf> {
    find_executable("pandoc")
}

pub fn find_gws() -> Option<PathBuf> {
    find_executable("gws").or_else(|| {
        let home = env::var_os("HOME")?;
        let candidate = PathBuf::from(home).join(".cargo/bin/gws");
        candidate.is_file().then_some(candidate)
    })
}

pub fn find_executable_in_path(name: &str, path: &OsStr) -> Option<PathBuf> {
    for dir in env::split_paths(path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_executable(name: &str) -> Option<PathBuf> {
    if let Some(path) = env::var_os("PATH") {
        if let Some(found) = find_executable_in_path(name, &path) {
            return Some(found);
        }
    }

    let mut directories: Vec<PathBuf> = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.push(home.join(".local/bin"));
        directories.push(home.join(".npm-global/bin"));
        directories.push(home.join(".cargo/bin"));
    }
    for fallback in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        directories.push(PathBuf::from(fallback));
    }
    for dir in directories {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn parse_gws_file(stdout: &str) -> Result<GwsCreatedFile, String> {
    serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Unable to parse gws JSON response: {error}"))
}

fn command_output_detail(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit status {}", output.status)
    }
}

fn temporary_output_path(
    document: &DocumentRecord,
    format: ExportFormat,
) -> Result<PathBuf, String> {
    let mut name = document
        .relative_path
        .replace(['/', '\\', ' ', ':'], "-")
        .trim_matches('-')
        .to_string();
    if name.is_empty() {
        name = document.id.clone();
    }
    let nonce = new_id("export");
    Ok(env::temp_dir().join(format!("margent-{name}-{nonce}.{}", format.extension())))
}

fn strip_yaml_frontmatter(markdown: &str) -> &str {
    let starts_with_yaml = markdown.starts_with("---\n") || markdown.starts_with("---\r\n");
    if !starts_with_yaml {
        return markdown;
    }

    let mut offset = 0;
    for (index, line) in markdown.split_inclusive('\n').enumerate() {
        offset += line.len();
        if index == 0 {
            continue;
        }
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            return &markdown[offset..];
        }
    }
    markdown
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn inline_image_data_uri(document_dir: Option<&Path>, dest_url: &str) -> Option<String> {
    if dest_url.is_empty()
        || dest_url.starts_with("data:")
        || dest_url.starts_with("//")
        || dest_url.contains("://")
        || dest_url.starts_with('#')
    {
        return None;
    }

    let document_dir = document_dir?;
    let candidate = if Path::new(dest_url).is_absolute() {
        PathBuf::from(dest_url)
    } else {
        document_dir.join(dest_url)
    };

    let mime = match candidate
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        _ => return None,
    };

    let metadata = fs::metadata(&candidate).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INLINE_IMAGE_BYTES {
        return None;
    }

    let bytes = fs::read(&candidate).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(relative_path: &str) -> DocumentRecord {
        DocumentRecord {
            schema_version: 1,
            id: "doc_test".into(),
            relative_path: relative_path.into(),
            display_name: Path::new(relative_path)
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or(relative_path)
                .into(),
            created_at: "2026-06-11T00:00:00Z".into(),
            updated_at: "2026-06-11T00:00:00Z".into(),
            current_content_hash: "sha256:test".into(),
            last_known_line_ending: "lf".into(),
            frontmatter_mode: "none".into(),
            word_count: 0,
            heading_index: Vec::new(),
        }
    }

    #[test]
    fn html_export_inlines_local_images_and_leaves_remote_urls() {
        let dir = std::env::temp_dir().join("margent-core-export-inline-test");
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("pic.png"), b"not-a-real-png").expect("write image");

        let doc = document("draft.md");
        let html = render_standalone_html(
            &doc,
            "![Local](pic.png)\n\n![Remote](https://example.com/x.png)\n",
            Some(&dir),
        );
        assert!(
            html.contains("data:image/png;base64,"),
            "local image should inline as data URI: {html}"
        );
        assert!(
            html.contains("https://example.com/x.png"),
            "remote image should pass through untouched"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_export_renders_markdown_and_strips_frontmatter() {
        let doc = document("draft.md");
        let html = render_standalone_html(
            &doc,
            "---\ntitle: Hidden\n---\n# Visible & Title\n\nHello **world**.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
            None,
        );

        assert!(html.contains("<title>Visible &amp; Title</title>"));
        assert!(html.contains("<h1>Visible &amp; Title</h1>"));
        assert!(html.contains("<strong>world</strong>"));
        assert!(html.contains("<table>"));
        assert!(!html.contains("title: Hidden"));
    }

    #[test]
    fn output_path_defaults_next_to_document_with_format_extension() {
        let root = Path::new("/tmp/margent");
        let doc = document("folder/draft.md");
        let output = output_path_for(root, &doc, None, ExportFormat::Html).expect("output path");

        assert_eq!(output, Path::new("/tmp/margent/folder/draft.html"));
    }

    #[test]
    fn html_export_writes_and_replaces_output_file() {
        let root = std::env::temp_dir().join(new_id("margent_core_export_test"));
        let doc = document("draft.md");
        let output = Path::new("exports").join("draft.html");
        let output_path = export_file(
            &root,
            &doc,
            "# First\n\nBody",
            ExportFormat::Html,
            Some(&output),
        )
        .expect("export html")
        .output_path;

        assert_eq!(output_path, root.join(&output));
        let first_html = fs::read_to_string(&output_path).expect("read first html export");
        assert!(first_html.contains("<h1>First</h1>"));

        export_file(
            &root,
            &doc,
            "# Second\n\nReplacement",
            ExportFormat::Html,
            Some(&output),
        )
        .expect("replace html export");

        let second_html = fs::read_to_string(&output_path).expect("read second html export");
        assert!(second_html.contains("<h1>Second</h1>"));
        assert!(!second_html.contains("<h1>First</h1>"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn format_can_be_inferred_from_output_extension() {
        assert_eq!(
            format_from_path(Path::new("exports/draft.html")),
            Some(ExportFormat::Html)
        );
        assert_eq!(
            format_from_path(Path::new("exports/draft.docx")),
            Some(ExportFormat::Docx)
        );
        assert_eq!(format_from_path(Path::new("exports/draft")), None);
    }

    #[test]
    fn pdf_error_points_to_desktop_print_path() {
        let doc = document("draft.md");
        let error = pdf_unavailable_error(&doc);

        assert!(error.contains("Cmd+P"));
        assert!(error.contains("File > Print"));
    }

    #[test]
    fn parses_gws_response_and_builds_fallback_url() {
        let result = parse_gws_created_file(
            r#"{"id":"abc123","name":"Draft","mimeType":"application/vnd.google-apps.document"}"#,
            ExportFormat::Docx,
            Some(PathBuf::from("/tmp/draft.docx")),
        )
        .expect("parse gws response");

        assert_eq!(result.id, "abc123");
        assert_eq!(result.url, "https://docs.google.com/document/d/abc123/edit");
        assert_eq!(result.source_format, ExportFormat::Docx);
        assert_eq!(
            result.intermediate_path,
            Some(PathBuf::from("/tmp/draft.docx"))
        );
    }

    #[test]
    fn executable_lookup_respects_custom_path() {
        let path = OsStr::new("/unlikely/bin:/also-unlikely");
        assert!(find_executable_in_path("definitely-not-margent-test-bin", path).is_none());
    }
}
