use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use walkdir::WalkDir;

use crate::models::*;

const ANCHOR_CONTEXT_RADIUS: usize = 48;
const STALE_PROPOSAL_WARNING: &str =
    "This proposal targets an older saved document hash and should be regenerated.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshotRecord {
    pub id: String,
    pub document_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub content: String,
    pub created_at: String,
    pub reason: String,
    pub proposal_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalMutationResultRecord {
    pub proposal: ProposalRecord,
    pub document: Option<DocumentRecord>,
    pub snapshot: Option<DocumentSnapshotRecord>,
    pub message: Option<String>,
}

// ── ID generation ───────────────────────────────────────────────────────────

pub fn next_id(prefix: &str) -> Result<String, String> {
    Ok(margent_core::id::new_id(prefix))
}

// ── Timestamp ───────────────────────────────────────────────────────────────

pub fn now_rfc3339() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|e| format!("Unable to format timestamp: {e}"))
}

// ── Hashing ─────────────────────────────────────────────────────────────────

pub fn document_id(relative_path: &str) -> String {
    let mut h = Sha256::new();
    h.update(relative_path.as_bytes());
    format!("doc_{}", &hex::encode(h.finalize())[..16])
}

pub fn content_hash(content: &str) -> String {
    margent_core::document::content_hash(content)
}

// ── Workspace discovery ─────────────────────────────────────────────────────

/// Walk upward from `start` looking for a directory that contains `.mdreview/`.
/// Returns the workspace root (the directory containing `.mdreview/`).
pub fn find_workspace_root(start: &Path) -> Result<PathBuf, String> {
    let mut cur = if start.is_file() {
        start
            .parent()
            .ok_or_else(|| "Cannot derive parent directory".to_string())?
            .to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        if cur.join(".mdreview").is_dir() {
            return Ok(cur);
        }
        match cur.parent() {
            Some(parent) => cur = parent.to_path_buf(),
            None => {
                return Err("No .mdreview/ directory found. Run `margent init` first.".to_string())
            }
        }
    }
}

// ── Layout ──────────────────────────────────────────────────────────────────

pub fn ensure_workspace_layout(root: &Path) -> Result<PathBuf, String> {
    let md = root.join(".mdreview");
    for sub in &["documents", "threads", "proposals", "agents", "authorship"] {
        fs::create_dir_all(md.join(sub))
            .map_err(|e| format!("Unable to create .mdreview/{sub}: {e}"))?;
    }
    fs::create_dir_all(md.join("snapshots"))
        .map_err(|e| format!("Unable to create .mdreview/snapshots: {e}"))?;
    let adapters = md.join("adapters.json");
    if !adapters.exists() {
        write_string_atomic(&adapters, "[]\n")?;
    }
    let events = md.join("events.ndjson");
    if !events.exists() {
        write_string_atomic(&events, "")?;
    }
    Ok(md)
}

// ── JSON I/O ────────────────────────────────────────────────────────────────

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text =
        fs::read_to_string(path).map_err(|e| format!("Unable to read {}: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("Unable to parse {}: {e}", path.display()))
}

fn read_json_from_scan<T: serde::de::DeserializeOwned>(
    path: &Path,
    sidecar_kind: &str,
) -> Result<Option<T>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Unable to read {}: {error}", path.display())),
    };

    match serde_json::from_str(&text) {
        Ok(record) => Ok(Some(record)),
        Err(error) => {
            eprintln!(
                "Warning: skipping corrupt {sidecar_kind} sidecar {}: {error}",
                path.display()
            );
            Ok(None)
        }
    }
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Unable to serialize {}: {e}", path.display()))?;
    write_string_atomic(path, &format!("{body}\n"))
}

pub fn write_string_atomic(path: &Path, body: &str) -> Result<(), String> {
    margent_core::io::write_string_atomic(path, body)
}

pub fn append_ndjson<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create {}: {e}", parent.display()))?;
    }
    let line =
        serde_json::to_string(value).map_err(|e| format!("Unable to serialize event: {e}"))?;
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|e| format!("Unable to open {}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| format!("Unable to append to {}: {e}", path.display()))
}

// ── Document helpers ────────────────────────────────────────────────────────

pub fn list_markdown_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let walker = WalkDir::new(root).into_iter().filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        if entry.file_type().is_dir() {
            let name = entry.file_name().to_string_lossy();
            return name != ".mdreview"
                && name != ".git"
                && name != "node_modules"
                && name != "target"
                && name != "dist";
        }
        true
    });
    for entry in walker {
        let entry = entry.map_err(|e| format!("Walk error: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("md" | "markdown")) {
            files.push(entry.into_path());
        }
    }
    files.sort();
    Ok(files)
}

pub fn relative_path_string(root: &Path, file: &Path) -> Result<String, String> {
    file.strip_prefix(root)
        .map_err(|e| format!("Unable to compute relative path: {e}"))
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn line_ending(content: &str) -> String {
    if content.contains("\r\n") {
        "crlf".into()
    } else {
        "lf".into()
    }
}

fn frontmatter_mode(content: &str) -> String {
    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        "yaml".into()
    } else {
        "none".into()
    }
}

fn word_count(content: &str) -> usize {
    content.split_whitespace().count()
}

pub fn extract_heading_index(content: &str) -> Vec<HeadingIndexEntry> {
    margent_core::document::extract_heading_index(content)
}

/// Build or update a DocumentRecord and persist it.
pub fn upsert_document_record(
    root: &Path,
    relative_path: &str,
    content: &str,
) -> Result<DocumentRecord, String> {
    let mdreview = ensure_workspace_layout(root)?;
    let doc_id = document_id(relative_path);
    let rec_path = mdreview.join("documents").join(format!("{doc_id}.json"));
    let existing: Option<DocumentRecord> = read_json(&rec_path)?;
    let now = now_rfc3339()?;
    let display_name = Path::new(relative_path)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(relative_path)
        .to_string();

    let record = DocumentRecord {
        schema_version: 1,
        id: doc_id,
        relative_path: relative_path.to_string(),
        display_name,
        created_at: existing
            .as_ref()
            .map(|r| r.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        current_content_hash: content_hash(content),
        last_known_line_ending: line_ending(content),
        frontmatter_mode: frontmatter_mode(content),
        word_count: word_count(content),
        heading_index: extract_heading_index(content),
    };
    write_json(&rec_path, &record)?;
    Ok(record)
}

pub fn save_document(
    root: &Path,
    relative_path: &str,
    content: &str,
) -> Result<DocumentRecord, String> {
    let abs = root.join(relative_path);
    write_string_atomic(&abs, content)?;
    upsert_document_record(root, relative_path, content)
}

pub fn create_markdown_file(
    root: &Path,
    relative_path: &str,
    content: &str,
) -> Result<DocumentRecord, String> {
    let normalized = normalize_document_relative_path(relative_path)?;
    ensure_markdown_path(&normalized)?;
    let normalized_relative_path = normalized.to_string_lossy().replace('\\', "/");
    let abs = root.join(&normalized);
    if abs.exists() {
        return Err(format!("{normalized_relative_path} already exists."));
    }
    write_string_atomic(&abs, content)?;
    let record = upsert_document_record(root, &normalized_relative_path, content)?;
    append_event(
        root,
        "document.created",
        None,
        Some(&record.id),
        None,
        Some(&record.relative_path),
    )?;
    Ok(record)
}

pub fn rename_markdown_file(
    root: &Path,
    from_relative_path: &str,
    to_relative_path: &str,
) -> Result<DocumentRecord, String> {
    if from_relative_path == to_relative_path {
        return Err("Choose a different path for the renamed document.".into());
    }

    let from_document = resolve_document(root, Some(from_relative_path))?;
    let to_normalized = normalize_document_relative_path(to_relative_path)?;
    ensure_markdown_path(&to_normalized)?;
    let normalized_to_relative_path = to_normalized.to_string_lossy().replace('\\', "/");
    let from_path = root.join(&from_document.relative_path);
    let to_path = root.join(&to_normalized);

    if to_path.exists() {
        return Err(format!("{normalized_to_relative_path} already exists."));
    }
    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create {}: {e}", parent.display()))?;
    }

    fs::rename(&from_path, &to_path).map_err(|e| {
        format!(
            "Unable to rename {} to {}: {e}",
            from_path.display(),
            to_path.display()
        )
    })?;
    let content = fs::read_to_string(&to_path)
        .map_err(|e| format!("Unable to read {}: {e}", to_path.display()))?;
    let renamed = upsert_document_record(root, &normalized_to_relative_path, &content)?;

    if from_document.id != renamed.id {
        remove_document_record(root, &from_document.id)?;
        retarget_document_sidecars(root, &from_document.id, &renamed.id)?;
    }

    append_event(
        root,
        "document.renamed",
        None,
        Some(&renamed.id),
        None,
        Some(&format!(
            "{} -> {}",
            from_document.relative_path, normalized_to_relative_path
        )),
    )?;
    Ok(renamed)
}

pub fn delete_markdown_file(root: &Path, relative_path: &str) -> Result<DocumentRecord, String> {
    let document = resolve_document(root, Some(relative_path))?;
    let document_path = root.join(&document.relative_path);
    let content = fs::read_to_string(&document_path).map_err(|e| {
        format!(
            "Unable to read {} before delete: {e}",
            document_path.display()
        )
    })?;
    let _snapshot = snapshot_document(root, &document, &content, "delete", None)?;

    fs::remove_file(&document_path)
        .map_err(|e| format!("Unable to delete {}: {e}", document_path.display()))?;
    remove_document_record(root, &document.id)?;
    remove_document_sidecars(root, &document.id)?;
    append_event(
        root,
        "document.deleted",
        None,
        Some(&document.id),
        None,
        Some(&document.relative_path),
    )?;
    Ok(document)
}

fn normalize_document_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err("Document path cannot be empty.".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Document path contains invalid control characters.".into());
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            std::path::Component::Normal(segment) => normalized.push(segment),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                return Err("Document path cannot contain '..'.".into())
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("Document path must stay inside the active workspace.".into())
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("Document path cannot be empty.".into());
    }
    Ok(normalized)
}

fn ensure_markdown_path(path: &Path) -> Result<(), String> {
    let is_markdown = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false);
    if !is_markdown {
        return Err("Markdown files must use a .md or .markdown extension.".into());
    }
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::Normal(segment)
                if matches!(segment.to_string_lossy().as_ref(), ".mdreview" | ".git" | "node_modules" | "target" | "dist")
        )
    }) {
        return Err("Document path uses a reserved workspace directory.".into());
    }
    Ok(())
}

fn remove_document_record(root: &Path, document_id: &str) -> Result<(), String> {
    let md = ensure_workspace_layout(root)?;
    remove_file_if_exists(&md.join("documents").join(format!("{document_id}.json")))
}

fn remove_document_sidecars(root: &Path, document_id: &str) -> Result<(), String> {
    let md = ensure_workspace_layout(root)?;
    for path in json_files_in_directory(&md.join("threads"))? {
        let Some(thread) = read_json_from_scan::<ThreadRecord>(&path, "thread")? else {
            continue;
        };
        if thread.document_id == document_id {
            remove_file_if_exists(&path)?;
        }
    }
    for path in json_files_in_directory(&md.join("proposals"))? {
        let Some(proposal) = read_json_from_scan::<ProposalRecord>(&path, "proposal")? else {
            continue;
        };
        if proposal.document_id == document_id {
            remove_file_if_exists(&path)?;
        }
    }
    Ok(())
}

fn retarget_document_sidecars(root: &Path, from_id: &str, to_id: &str) -> Result<(), String> {
    let md = ensure_workspace_layout(root)?;
    let now = now_rfc3339()?;
    for path in json_files_in_directory(&md.join("threads"))? {
        let Some(mut thread) = read_json_from_scan::<ThreadRecord>(&path, "thread")? else {
            continue;
        };
        if thread.document_id == from_id {
            thread.document_id = to_id.to_string();
            thread.updated_at = now.clone();
            save_thread(root, &thread)?;
        }
    }
    for path in json_files_in_directory(&md.join("proposals"))? {
        let Some(mut proposal) = read_json_from_scan::<ProposalRecord>(&path, "proposal")? else {
            continue;
        };
        if proposal.document_id == from_id {
            proposal.document_id = to_id.to_string();
            proposal.updated_at = now.clone();
            save_proposal(root, &proposal)?;
        }
    }
    Ok(())
}

fn json_files_in_directory(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    if !directory.exists() {
        return Ok(paths);
    }
    for entry in fs::read_dir(directory)
        .map_err(|e| format!("Unable to read {}: {e}", directory.display()))?
    {
        let entry = entry.map_err(|e| format!("Unable to inspect sidecar records: {e}"))?;
        let path = entry.path();
        if path.is_file() {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Unable to delete {}: {error}", path.display())),
    }
}

// ── Thread loading ──────────────────────────────────────────────────────────

/// Load all threads for a document, sorted by createdAt ascending (for ordinal numbering).
pub fn load_threads_sorted(root: &Path, document_id: &str) -> Result<Vec<ThreadRecord>, String> {
    let md = ensure_workspace_layout(root)?;
    let threads_dir = md.join("threads");
    let mut threads = Vec::new();
    for entry in
        fs::read_dir(&threads_dir).map_err(|e| format!("Unable to read threads dir: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Thread dir entry error: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(thread) = read_json_from_scan::<ThreadRecord>(&path, "thread")? {
            let thread = normalize_thread_record(thread);
            if thread.document_id == document_id {
                threads.push(thread);
            }
        }
    }
    // Sort by createdAt ascending for stable ordinals
    threads.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(threads)
}

/// Load all threads across all documents, sorted by createdAt ascending.
pub fn load_all_threads_sorted(root: &Path) -> Result<Vec<ThreadRecord>, String> {
    let md = ensure_workspace_layout(root)?;
    let threads_dir = md.join("threads");
    let mut threads = Vec::new();
    for entry in
        fs::read_dir(&threads_dir).map_err(|e| format!("Unable to read threads dir: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Thread dir entry error: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(thread) = read_json_from_scan::<ThreadRecord>(&path, "thread")? {
            threads.push(normalize_thread_record(thread));
        }
    }
    threads.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(threads)
}

/// Load a single thread by ID.
pub fn load_thread(root: &Path, thread_id: &str) -> Result<ThreadRecord, String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("threads").join(format!("{thread_id}.json"));
    read_json::<ThreadRecord>(&path)?
        .map(normalize_thread_record)
        .ok_or_else(|| format!("Thread {thread_id} not found."))
}

/// Save a thread record.
pub fn save_thread(root: &Path, thread: &ThreadRecord) -> Result<(), String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("threads").join(format!("{}.json", thread.id));
    let normalized = normalize_thread_record(thread.clone());
    write_json(&path, &normalized)
}

pub fn migrate_legacy_thread_records(root: &Path) -> Result<(usize, usize), String> {
    let md = ensure_workspace_layout(root)?;
    let threads_dir = md.join("threads");
    let mut total = 0usize;
    let mut migrated = 0usize;

    for entry in
        fs::read_dir(&threads_dir).map_err(|e| format!("Unable to read threads dir: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Thread dir entry error: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(thread) = read_json_from_scan::<ThreadRecord>(&path, "thread")? else {
            continue;
        };

        total += 1;
        if !thread_needs_migration(&thread) {
            continue;
        }

        let normalized = normalize_thread_record(thread);
        write_json(&path, &normalized)?;
        migrated += 1;
    }

    Ok((total, migrated))
}

fn normalize_thread_record(mut normalized: ThreadRecord) -> ThreadRecord {
    normalized.schema_version = CURRENT_THREAD_SCHEMA_VERSION;
    if normalized.anchor.kind.trim().is_empty() {
        normalized.anchor.kind = "text_span".into();
    }
    if normalized.created_content_hash.is_none() {
        normalized.created_content_hash = Some(normalized.anchor.base_content_hash.clone());
    }
    if normalized.last_reanchor_content_hash.is_none() {
        normalized.last_reanchor_content_hash = Some(normalized.anchor.base_content_hash.clone());
    }
    normalized
}

fn thread_needs_migration(thread: &ThreadRecord) -> bool {
    thread.schema_version != CURRENT_THREAD_SCHEMA_VERSION
        || thread.anchor.kind.trim().is_empty()
        || thread.created_content_hash.is_none()
        || thread.last_reanchor_content_hash.is_none()
}

pub fn build_anchor_from_quote(
    document: &DocumentRecord,
    content: &str,
    quote: &str,
    occurrence: usize,
) -> Result<AnchorRecord, String> {
    let normalized_quote = quote.trim();
    if normalized_quote.is_empty() {
        return Err("Quote cannot be empty.".into());
    }

    if occurrence == 0 {
        return Err("Occurrence must be 1 or greater.".into());
    }

    let matches: Vec<_> = content.match_indices(normalized_quote).collect();
    if matches.is_empty() {
        return Err(format!(
            "Quote \"{normalized_quote}\" was not found in {}.",
            document.relative_path
        ));
    }

    if occurrence > matches.len() {
        return Err(format!(
            "Quote \"{normalized_quote}\" only matched {} time(s) in {}.",
            matches.len(),
            document.relative_path
        ));
    }

    let (start_byte, matched_quote) = matches[occurrence - 1];
    let end_byte = start_byte + matched_quote.len();
    let start_offset_utf16 = content[..start_byte].encode_utf16().count();
    let end_offset_utf16 = content[..end_byte].encode_utf16().count();
    let (start_line, start_column) = line_col_for_byte(content, start_byte)?;
    let (end_line, end_column) = line_col_for_byte(content, end_byte)?;
    let (kind, footnote) =
        resolve_footnote_anchor_semantic(content, start_byte, end_byte, matched_quote);

    Ok(AnchorRecord {
        quote: matched_quote.to_string(),
        prefix_context: prefix_context(content, start_byte),
        suffix_context: suffix_context(content, end_byte),
        start_offset_utf16,
        end_offset_utf16,
        start_line,
        start_column,
        end_line,
        end_column,
        heading_path: resolve_heading_path(&document.heading_index, start_line),
        block_fingerprint: content_hash(&normalize_block_text(&find_containing_block(
            content, start_line, end_line,
        ))),
        base_content_hash: document.current_content_hash.clone(),
        kind,
        footnote,
        state: "attached".into(),
        confidence: 1.0,
    })
}

pub fn extract_anchor_text(content: &str, anchor: &AnchorRecord) -> Result<String, String> {
    let start_byte = utf16_offset_to_byte_index(content, anchor.start_offset_utf16)?;
    let end_byte = utf16_offset_to_byte_index(content, anchor.end_offset_utf16)?;
    if start_byte > end_byte || end_byte > content.len() {
        return Err("Anchor offsets are out of bounds for the current document.".into());
    }

    content
        .get(start_byte..end_byte)
        .map(str::to_string)
        .ok_or_else(|| "Unable to slice the anchored text from the document.".into())
}

pub fn replace_anchor_text(
    content: &str,
    anchor: &AnchorRecord,
    replacement_text: &str,
) -> Result<String, String> {
    let start_byte = utf16_offset_to_byte_index(content, anchor.start_offset_utf16)?;
    let end_byte = utf16_offset_to_byte_index(content, anchor.end_offset_utf16)?;
    if start_byte > end_byte || end_byte > content.len() {
        return Err("Anchor offsets are out of bounds for the current document.".into());
    }

    let prefix = content
        .get(..start_byte)
        .ok_or_else(|| "Unable to slice the document prefix for replacement.".to_string())?;
    let suffix = content
        .get(end_byte..)
        .ok_or_else(|| "Unable to slice the document suffix for replacement.".to_string())?;

    Ok(format!("{prefix}{replacement_text}{suffix}"))
}

fn utf16_offset_to_byte_index(content: &str, utf16_offset: usize) -> Result<usize, String> {
    let mut current_utf16 = 0usize;

    for (byte_index, ch) in content.char_indices() {
        if current_utf16 == utf16_offset {
            return Ok(byte_index);
        }

        current_utf16 += ch.len_utf16();
        if current_utf16 > utf16_offset {
            return Err(format!(
                "UTF-16 offset {utf16_offset} lands inside a character boundary."
            ));
        }
    }

    if current_utf16 == utf16_offset {
        Ok(content.len())
    } else {
        Err(format!(
            "UTF-16 offset {utf16_offset} is beyond the document length."
        ))
    }
}

#[allow(clippy::too_many_arguments)]
pub fn create_thread(
    root: &Path,
    document: &DocumentRecord,
    title: &str,
    body: &str,
    anchor: AnchorRecord,
    created_by: &str,
    author_type: &str,
    author_name: &str,
    agent_id: Option<&str>,
) -> Result<ThreadRecord, String> {
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        return Err("A thread needs an initial comment.".into());
    }

    let normalized_title = default_thread_title(title, &anchor.quote);
    let now = now_rfc3339()?;
    let thread_id = next_id("thread")?;
    let message_id = next_id("msg")?;

    let base_content_hash = anchor.base_content_hash.clone();
    let tags = if anchor.kind == "document" {
        vec!["document".into()]
    } else {
        Vec::new()
    };

    let thread = ThreadRecord {
        schema_version: CURRENT_THREAD_SCHEMA_VERSION,
        id: thread_id.clone(),
        document_id: document.id.clone(),
        status: "open".into(),
        created_at: now.clone(),
        updated_at: now.clone(),
        created_by: created_by.to_string(),
        title: normalized_title,
        tags,
        anchor,
        created_content_hash: Some(base_content_hash.clone()),
        last_reanchor_content_hash: Some(base_content_hash),
        review_round: None,
        review_done: false,
        messages: vec![MessageRecord {
            id: message_id,
            thread_id: thread_id.clone(),
            author_type: author_type.to_string(),
            author_name: author_name.to_string(),
            agent_id: agent_id.map(str::to_string),
            adapter_id: None,
            reply_to_message_id: None,
            created_at: now.clone(),
            body: trimmed_body.to_string(),
            kind: "comment".into(),
        }],
        linked_proposal_ids: Vec::new(),
        provider_sessions: std::collections::HashMap::new(),
    };

    save_thread(root, &thread)?;
    append_event(
        root,
        "thread.created",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        Some(trimmed_body),
    )?;

    Ok(thread)
}

#[allow(clippy::too_many_arguments)]
pub fn add_thread_message(
    root: &Path,
    thread_id: &str,
    body: &str,
    kind: &str,
    author_type: &str,
    author_name: &str,
    agent_id: Option<&str>,
    reply_to_message_id: Option<&str>,
) -> Result<ThreadRecord, String> {
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        return Err("Replies cannot be empty.".into());
    }

    let mut thread = load_thread(root, thread_id)?;
    let now = now_rfc3339()?;

    thread.messages.push(MessageRecord {
        id: next_id("msg")?,
        thread_id: thread.id.clone(),
        author_type: author_type.to_string(),
        author_name: author_name.to_string(),
        agent_id: agent_id.map(str::to_string),
        adapter_id: None,
        reply_to_message_id: reply_to_message_id.map(str::to_string),
        created_at: now.clone(),
        body: trimmed_body.to_string(),
        kind: kind.to_string(),
    });
    thread.updated_at = now;

    save_thread(root, &thread)?;
    append_event(
        root,
        "thread.message_added",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        Some(trimmed_body),
    )?;

    Ok(thread)
}

pub fn delete_thread(root: &Path, thread_id: &str) -> Result<ThreadRecord, String> {
    let thread = load_thread(root, thread_id)?;
    let md = ensure_workspace_layout(root)?;
    let path = md.join("threads").join(format!("{thread_id}.json"));
    fs::remove_file(&path).map_err(|e| format!("Unable to delete {}: {e}", path.display()))?;
    append_event(
        root,
        "thread.deleted",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        Some(&thread.title),
    )?;
    Ok(thread)
}

pub fn delete_thread_message(
    root: &Path,
    thread_id: &str,
    message_ordinal: usize,
) -> Result<Option<ThreadRecord>, String> {
    let mut thread = load_thread(root, thread_id)?;
    if message_ordinal == 0 || message_ordinal > thread.messages.len() {
        return Err(format!(
            "Message ordinal {message_ordinal} is out of range. There are {} message(s).",
            thread.messages.len()
        ));
    }

    let removed = thread.messages.remove(message_ordinal - 1);
    if thread.messages.is_empty() {
        delete_thread(root, thread_id)?;
        return Ok(None);
    }

    for message in &mut thread.messages {
        if message.reply_to_message_id.as_deref() == Some(removed.id.as_str()) {
            message.reply_to_message_id = None;
        }
    }

    thread.updated_at = now_rfc3339()?;
    save_thread(root, &thread)?;
    append_event(
        root,
        "thread.message_deleted",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        Some(&removed.id),
    )?;
    Ok(Some(thread))
}

pub fn resolve_thread(root: &Path, thread_id: &str) -> Result<ThreadRecord, String> {
    let mut thread = load_thread(root, thread_id)?;
    if thread.status == "resolved" {
        return Err("Thread is already resolved.".into());
    }

    thread.status = "resolved".into();
    thread.updated_at = now_rfc3339()?;
    save_thread(root, &thread)?;
    append_event(
        root,
        "thread.resolved",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        None,
    )?;
    Ok(thread)
}

pub fn reopen_thread(root: &Path, thread_id: &str) -> Result<ThreadRecord, String> {
    let mut thread = load_thread(root, thread_id)?;
    if thread.status == "open" {
        return Err("Thread is already open.".into());
    }

    thread.status = "open".into();
    thread.updated_at = now_rfc3339()?;
    save_thread(root, &thread)?;
    append_event(
        root,
        "thread.reopened",
        Some(&thread.id),
        Some(&thread.document_id),
        None,
        None,
    )?;
    Ok(thread)
}

pub fn resolve_message_by_ordinal(
    thread: &ThreadRecord,
    ordinal: usize,
) -> Result<MessageRecord, String> {
    if ordinal == 0 || ordinal > thread.messages.len() {
        return Err(format!(
            "Message ordinal {ordinal} is out of range. There are {} message(s).",
            thread.messages.len()
        ));
    }
    Ok(thread.messages[ordinal - 1].clone())
}

// ── Document loading ────────────────────────────────────────────────────────

/// Load all document records from .mdreview/documents/.
pub fn load_all_documents(root: &Path) -> Result<Vec<DocumentRecord>, String> {
    let md = ensure_workspace_layout(root)?;
    let docs_dir = md.join("documents");
    let mut docs = Vec::new();
    for entry in
        fs::read_dir(&docs_dir).map_err(|e| format!("Unable to read documents dir: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Document dir entry error: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(doc) = read_json_from_scan::<DocumentRecord>(&path, "document")? {
            docs.push(doc);
        }
    }
    Ok(docs)
}

/// Load a document record by ID.
pub fn load_document_by_id(root: &Path, doc_id: &str) -> Result<DocumentRecord, String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("documents").join(format!("{doc_id}.json"));
    read_json::<DocumentRecord>(&path)?.ok_or_else(|| format!("Document {doc_id} not found."))
}

/// Read the actual markdown content of a document.
pub fn read_document_content(root: &Path, relative_path: &str) -> Result<String, String> {
    let abs = root.join(relative_path);
    fs::read_to_string(&abs).map_err(|e| format!("Unable to read {}: {e}", abs.display()))
}

// ── Proposal loading ────────────────────────────────────────────────────────

pub fn load_all_proposals(root: &Path) -> Result<Vec<ProposalRecord>, String> {
    let md = ensure_workspace_layout(root)?;
    let proposals_dir = md.join("proposals");
    let mut proposals = Vec::new();
    for entry in
        fs::read_dir(&proposals_dir).map_err(|e| format!("Unable to read proposals dir: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Proposal dir entry error: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(p) = read_json_from_scan::<ProposalRecord>(&path, "proposal")? {
            proposals.push(p);
        }
    }
    Ok(proposals)
}

pub fn load_proposal(root: &Path, proposal_id: &str) -> Result<ProposalRecord, String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("proposals").join(format!("{proposal_id}.json"));
    read_json::<ProposalRecord>(&path)?.ok_or_else(|| format!("Proposal {proposal_id} not found."))
}

/// Save a proposal record.
pub fn save_proposal(root: &Path, proposal: &ProposalRecord) -> Result<(), String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("proposals").join(format!("{}.json", proposal.id));
    write_json(&path, proposal)
}

fn compute_unified_diff(before: &str, after: &str) -> String {
    TextDiff::from_lines(before, after)
        .unified_diff()
        .context_radius(2)
        .header("before", "after")
        .to_string()
}

pub fn accept_proposal(
    root: &Path,
    proposal_id: &str,
    edited_document_text: Option<&str>,
) -> Result<ProposalMutationResultRecord, String> {
    let mut proposal = load_proposal(root, proposal_id)?;
    match proposal.status.as_str() {
        "accepted" => return Err("Proposal has already been accepted.".into()),
        "rejected" => return Err("Rejected proposals cannot be accepted.".into()),
        "failed" => return Err("Failed proposals cannot be accepted.".into()),
        "pending" => {}
        "stale" => return Err(
            "This proposal targets an older version of the document and can no longer be applied."
                .into(),
        ),
        other => return Err(format!("Unsupported proposal status {other}.")),
    }

    let document = load_document_by_id(root, &proposal.document_id)?;
    let current_content = read_document_content(root, &document.relative_path)?;
    let current_hash = content_hash(&current_content);
    if current_hash != proposal.base_content_hash {
        mark_proposal_stale(root, &mut proposal)?;
        return Err(
            "The document changed after this proposal was generated, so it was marked stale instead of being applied. Re-run the proposal."
                .into(),
        );
    }

    let updated_document_text = edited_document_text
        .map(str::to_string)
        .or_else(|| proposal.updated_document_text.clone())
        .ok_or_else(|| {
            "Only updated-document proposals can be accepted in the current release.".to_string()
        })?;
    let snapshot = snapshot_document(
        root,
        &document,
        &current_content,
        "proposal.accept",
        Some(&proposal.id),
    )?;
    let document = save_document(root, &document.relative_path, &updated_document_text)?;

    if edited_document_text.is_some() {
        proposal.computed_diff = compute_unified_diff(&current_content, &updated_document_text);
        proposal.updated_document_text = Some(updated_document_text.clone());
        proposal.unified_diff = None;
    }
    proposal.status = "accepted".into();
    proposal.updated_at = now_rfc3339()?;
    save_proposal(root, &proposal)?;
    record_authorship_for_acceptance(
        root,
        &document,
        &current_content,
        &updated_document_text,
        &proposal,
        edited_document_text.is_some(),
        &proposal.updated_at,
    )?;
    append_event(
        root,
        "proposal.accepted",
        None,
        Some(&proposal.document_id),
        Some(&proposal.id),
        None,
    )?;
    resolve_threads_for_acceptance(root, &proposal.resolve_thread_ids)?;
    refresh_pending_proposals_for_document(root, &proposal.document_id, Some(&proposal.id))?;

    Ok(ProposalMutationResultRecord {
        proposal,
        document: Some(document),
        snapshot: Some(snapshot),
        message: None,
    })
}

pub fn record_authorship_for_acceptance(
    root: &Path,
    document: &DocumentRecord,
    before: &str,
    after: &str,
    proposal: &ProposalRecord,
    edited_at_accept: bool,
    accepted_at: &str,
) -> Result<usize, String> {
    let source = margent_core::authorship::AuthorshipSourceRecord {
        proposal_id: proposal.id.clone(),
        adapter_id: proposal.adapter_id.clone(),
        agent_id: match proposal.adapter_id.as_str() {
            "codex" | "claude" => Some(proposal.adapter_id.clone()),
            _ => None,
        },
        author_name: match proposal.adapter_id.as_str() {
            "codex" => "Codex".into(),
            "claude" => "Claude Code".into(),
            other => other.to_string(),
        },
        accepted_at: accepted_at.to_string(),
        edited_at_accept,
    };

    let mut span_count = 0usize;
    let mut record = margent_core::authorship::build_authorship_record(
        &document.id,
        &document.relative_path,
        before,
        after,
        accepted_at,
        source,
        || {
            span_count += 1;
            next_id("span").unwrap_or_else(|_| format!("span_fallback_{span_count}"))
        },
    );

    let new_span_count = record.spans.len();
    if new_span_count == 0 {
        return Ok(0);
    }

    let md = ensure_workspace_layout(root)?;
    let path = md.join("authorship").join(format!("{}.json", document.id));
    if let Some(existing) = read_json::<margent_core::authorship::AuthorshipMapRecord>(&path)? {
        let mut spans = existing.spans;
        spans.extend(record.spans);
        record.spans = spans;
    }
    write_json(&path, &record)?;
    Ok(new_span_count)
}

fn resolve_threads_for_acceptance(root: &Path, thread_ids: &[String]) -> Result<(), String> {
    for thread_id in thread_ids {
        match load_thread(root, thread_id) {
            Ok(thread) if thread.status == "resolved" => {}
            Ok(_) => {
                resolve_thread(root, thread_id)?;
            }
            Err(error) if error.contains("not found") => {}
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

pub fn reject_proposal(
    root: &Path,
    proposal_id: &str,
) -> Result<ProposalMutationResultRecord, String> {
    let mut proposal = load_proposal(root, proposal_id)?;
    match proposal.status.as_str() {
        "accepted" => return Err("Accepted proposals cannot be rejected.".into()),
        "rejected" => return Err("Proposal has already been rejected.".into()),
        "failed" => return Err("Failed proposals cannot be rejected.".into()),
        "pending" | "stale" => {}
        other => return Err(format!("Unsupported proposal status {other}.")),
    }

    proposal.status = "rejected".into();
    proposal.updated_at = now_rfc3339()?;
    save_proposal(root, &proposal)?;
    append_event(
        root,
        "proposal.rejected",
        None,
        Some(&proposal.document_id),
        Some(&proposal.id),
        None,
    )?;

    Ok(ProposalMutationResultRecord {
        proposal,
        document: None,
        snapshot: None,
        message: None,
    })
}

pub fn snapshot_document(
    root: &Path,
    document: &DocumentRecord,
    content: &str,
    reason: &str,
    proposal_id: Option<&str>,
) -> Result<DocumentSnapshotRecord, String> {
    let md = ensure_workspace_layout(root)?;
    let snapshot_id = next_id("snapshot")?;
    let created_at = now_rfc3339()?;
    let record = DocumentSnapshotRecord {
        id: snapshot_id.clone(),
        document_id: document.id.clone(),
        relative_path: document.relative_path.clone(),
        content_hash: content_hash(content),
        content: content.to_string(),
        created_at,
        reason: reason.to_string(),
        proposal_id: proposal_id.map(str::to_string),
    };
    let path = md.join("snapshots").join(format!("{snapshot_id}.json"));
    write_json(&path, &record)?;
    append_event(
        root,
        "document.snapshot",
        None,
        Some(&document.id),
        proposal_id,
        Some(reason),
    )?;
    Ok(record)
}

pub fn revert_latest_snapshot(
    root: &Path,
    relative_path: Option<&str>,
) -> Result<(DocumentSnapshotRecord, DocumentRecord), String> {
    let normalized_relative_path = relative_path
        .map(normalize_document_relative_path)
        .transpose()?
        .map(|path| path.to_string_lossy().replace('\\', "/"));
    let snapshot = load_latest_snapshot(root, normalized_relative_path.as_deref())?;
    let document = save_document(root, &snapshot.relative_path, &snapshot.content)?;
    append_event(
        root,
        "document.reverted",
        None,
        Some(&document.id),
        snapshot.proposal_id.as_deref(),
        Some(&snapshot.id),
    )?;
    Ok((snapshot, document))
}

fn load_latest_snapshot(
    root: &Path,
    relative_path: Option<&str>,
) -> Result<DocumentSnapshotRecord, String> {
    let md = ensure_workspace_layout(root)?;
    let snapshots_dir = md.join("snapshots");
    let mut snapshots = Vec::new();
    for path in json_files_in_directory(&snapshots_dir)? {
        let Some(snapshot) = read_json_from_scan::<DocumentSnapshotRecord>(&path, "snapshot")?
        else {
            continue;
        };
        if relative_path.is_none_or(|path| snapshot.relative_path == path) {
            snapshots.push(snapshot);
        }
    }
    snapshots.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    snapshots
        .into_iter()
        .next()
        .ok_or_else(|| "No Margent document snapshots found.".into())
}

fn mark_proposal_stale(root: &Path, proposal: &mut ProposalRecord) -> Result<(), String> {
    proposal.status = "stale".into();
    proposal.updated_at = now_rfc3339()?;
    if !proposal
        .warnings
        .iter()
        .any(|warning| warning == STALE_PROPOSAL_WARNING)
    {
        proposal.warnings.push(STALE_PROPOSAL_WARNING.into());
    }
    save_proposal(root, proposal)?;
    append_event(
        root,
        "proposal.stale",
        None,
        Some(&proposal.document_id),
        Some(&proposal.id),
        None,
    )?;
    Ok(())
}

fn refresh_pending_proposals_for_document(
    root: &Path,
    document_id: &str,
    exclude_proposal_id: Option<&str>,
) -> Result<(), String> {
    let document = load_document_by_id(root, document_id)?;
    let current_content = read_document_content(root, &document.relative_path)?;
    let current_hash = content_hash(&current_content);
    for mut proposal in load_all_proposals(root)? {
        if proposal.document_id != document_id
            || exclude_proposal_id == Some(proposal.id.as_str())
            || proposal.status != "pending"
            || proposal.base_content_hash == current_hash
        {
            continue;
        }
        mark_proposal_stale(root, &mut proposal)?;
    }
    Ok(())
}

// ── Agent cursor ────────────────────────────────────────────────────────────

pub fn load_agent_cursor(root: &Path, agent_id: &str) -> Result<Option<AgentCursorRecord>, String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("agents").join(format!("{agent_id}.json"));
    read_json::<AgentCursorRecord>(&path)
}

pub fn save_agent_cursor(root: &Path, cursor: &AgentCursorRecord) -> Result<(), String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("agents").join(format!("{}.json", cursor.agent_id));
    write_json(&path, cursor)
}

// ── Event log ───────────────────────────────────────────────────────────────

pub fn append_event(
    root: &Path,
    event_type: &str,
    thread_id: Option<&str>,
    document_id: Option<&str>,
    proposal_id: Option<&str>,
    body: Option<&str>,
) -> Result<String, String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("events.ndjson");
    let timestamp = now_rfc3339()?;
    let event_id = next_id("evt")?;
    let event = serde_json::json!({
        "id": event_id,
        "timestamp": timestamp,
        "eventType": event_type,
        "threadId": thread_id,
        "documentId": document_id,
        "proposalId": proposal_id,
        "body": body,
    });
    append_ndjson(&path, &event)?;
    Ok(event_id)
}

/// Load events from events.ndjson.
pub fn load_events(root: &Path) -> Result<Vec<EventRecord>, String> {
    let md = ensure_workspace_layout(root)?;
    let path = md.join("events.ndjson");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("Unable to read events: {e}"))?;
    let mut events = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let evt: EventRecord = serde_json::from_str(trimmed)
            .map_err(|e| format!("Unable to parse event line: {e}"))?;
        events.push(evt);
    }
    Ok(events)
}

// ── Document auto-detect ────────────────────────────────────────────────────

/// Auto-detect the document to operate on.
/// If `--document` was given, use that relative path.
/// Otherwise, look at all registered documents. If exactly one exists, use it.
/// If multiple exist, return an error listing them.
pub fn resolve_document(root: &Path, explicit: Option<&str>) -> Result<DocumentRecord, String> {
    if let Some(rel) = explicit {
        let doc_id = document_id(rel);
        return load_document_by_id(root, &doc_id);
    }

    let docs = load_all_documents(root)?;
    match docs.len() {
        0 => Err("No documents found in .mdreview/. Open a document in Margent first.".into()),
        1 => Ok(docs.into_iter().next().unwrap()),
        n => {
            let paths: Vec<_> = docs.iter().map(|d| d.relative_path.as_str()).collect();
            Err(format!(
                "Multiple documents found ({n}). Use --document to specify one:\n  {}",
                paths.join("\n  ")
            ))
        }
    }
}

/// Resolve a thread by its 1-based ordinal number within a document.
/// Ordinals are assigned by sorting threads by createdAt ascending.
pub fn resolve_thread_by_ordinal(
    root: &Path,
    document_id: &str,
    ordinal: usize,
) -> Result<ThreadRecord, String> {
    let threads = load_threads_sorted(root, document_id)?;
    if ordinal == 0 || ordinal > threads.len() {
        return Err(format!(
            "Thread ordinal {ordinal} is out of range. There are {} thread(s).",
            threads.len()
        ));
    }
    Ok(threads.into_iter().nth(ordinal - 1).unwrap())
}

/// Resolve a thread by its stable ID and verify it belongs to the target document.
pub fn resolve_thread_by_id(
    root: &Path,
    document_id: &str,
    thread_id: &str,
) -> Result<ThreadRecord, String> {
    let thread = load_thread(root, thread_id)?;
    if thread.document_id != document_id {
        return Err(format!(
            "Thread {thread_id} does not belong to document {document_id}."
        ));
    }
    Ok(thread)
}

fn default_thread_title(explicit_title: &str, quote: &str) -> String {
    let normalized = explicit_title.trim();
    if !normalized.is_empty() {
        return normalized.to_string();
    }

    let fallback = quote.split_whitespace().collect::<Vec<_>>().join(" ");
    if fallback.is_empty() {
        return "New thread".into();
    }

    if fallback.chars().count() > 56 {
        let shortened: String = fallback.chars().take(53).collect();
        format!("{shortened}...")
    } else {
        fallback
    }
}

fn line_col_for_byte(content: &str, byte_idx: usize) -> Result<(usize, usize), String> {
    if byte_idx > content.len() || !content.is_char_boundary(byte_idx) {
        return Err("Invalid anchor offset computed for quote match.".into());
    }

    let prefix = &content[..byte_idx];
    let line = prefix.chars().filter(|ch| *ch == '\n').count() + 1;
    let line_start = prefix.rfind('\n').map(|idx| idx + 1).unwrap_or(0);
    let column = content[line_start..byte_idx].chars().count() + 1;
    Ok((line, column))
}

fn prefix_context(content: &str, start_byte: usize) -> String {
    let prefix = &content[..start_byte];
    let start = prefix
        .char_indices()
        .rev()
        .nth(ANCHOR_CONTEXT_RADIUS.saturating_sub(1))
        .map(|(idx, _)| idx)
        .unwrap_or(0);
    prefix[start..].to_string()
}

fn suffix_context(content: &str, end_byte: usize) -> String {
    let suffix = &content[end_byte..];
    let end = suffix
        .char_indices()
        .nth(ANCHOR_CONTEXT_RADIUS)
        .map(|(idx, _)| idx)
        .unwrap_or(suffix.len());
    suffix[..end].to_string()
}

fn resolve_heading_path(headings: &[HeadingIndexEntry], line: usize) -> Vec<String> {
    let mut stack: Vec<&HeadingIndexEntry> = Vec::new();

    for heading in headings {
        if heading.line > line {
            break;
        }

        while stack
            .last()
            .is_some_and(|previous| previous.depth >= heading.depth)
        {
            stack.pop();
        }

        stack.push(heading);
    }

    stack
        .into_iter()
        .map(|heading| heading.text.clone())
        .collect()
}

fn find_containing_block(content: &str, start_line: usize, end_line: usize) -> String {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return String::new();
    }

    let mut block_start = start_line.saturating_sub(1).min(lines.len() - 1);
    let mut block_end = end_line.saturating_sub(1).min(lines.len() - 1);

    while block_start > 0 && !lines[block_start - 1].trim().is_empty() {
        block_start -= 1;
    }

    while block_end + 1 < lines.len() && !lines[block_end + 1].trim().is_empty() {
        block_end += 1;
    }

    lines[block_start..=block_end].join("\n")
}

fn normalize_block_text(block: &str) -> String {
    block
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn resolve_footnote_anchor_semantic(
    content: &str,
    start_byte: usize,
    end_byte: usize,
    matched_quote: &str,
) -> (String, Option<FootnoteAnchorMetadata>) {
    if let Some(definition) = collect_footnote_definitions(content)
        .into_iter()
        .find(|definition| {
            start_byte >= definition.block_start_byte && end_byte <= definition.block_end_byte
        })
    {
        return (
            "footnote_definition".into(),
            Some(FootnoteAnchorMetadata {
                label: definition.label,
                occurrence: definition.occurrence,
            }),
        );
    }

    if let Some(reference) = collect_footnote_references(content)
        .into_iter()
        .find(|reference| {
            start_byte == reference.start_byte
                && end_byte == reference.end_byte
                && matched_quote == reference.token
        })
    {
        return (
            "footnote_reference".into(),
            Some(FootnoteAnchorMetadata {
                label: reference.label,
                occurrence: reference.occurrence,
            }),
        );
    }

    ("text_span".into(), None)
}

fn collect_footnote_references(content: &str) -> Vec<FootnoteReference> {
    let mut references = Vec::new();
    let mut occurrence_by_label: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut search_start = 0usize;

    while let Some(relative_start) = content[search_start..].find("[^") {
        let token_start = search_start + relative_start;
        let line_end = content[token_start..]
            .find('\n')
            .map(|offset| token_start + offset)
            .unwrap_or(content.len());
        let Some(relative_close) = content[token_start..line_end].find(']') else {
            break;
        };
        let token_end = token_start + relative_close + 1;

        if token_end <= token_start + 2 {
            search_start = token_end;
            continue;
        }

        if is_footnote_definition_token(content, token_start, token_end) {
            search_start = token_end;
            continue;
        }

        let label = content[token_start + 2..token_end - 1].to_string();
        let occurrence = occurrence_by_label.get(&label).copied().unwrap_or(0) + 1;
        occurrence_by_label.insert(label.clone(), occurrence);

        references.push(FootnoteReference {
            label,
            occurrence,
            start_byte: token_start,
            end_byte: token_end,
            token: content[token_start..token_end].to_string(),
        });

        search_start = token_end;
    }

    references
}

fn collect_footnote_definitions(content: &str) -> Vec<FootnoteDefinition> {
    let lines = collect_line_infos(content);
    let mut definitions = Vec::new();
    let mut occurrence_by_label: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut index = 0usize;

    while index < lines.len() {
        let Some(label) = parse_footnote_definition_line(lines[index].body) else {
            index += 1;
            continue;
        };
        let mut block_end_index = index;

        while block_end_index + 1 < lines.len() {
            let next = &lines[block_end_index + 1];
            if next.body.trim().is_empty()
                || next.body.starts_with("    ")
                || next.body.starts_with('\t')
            {
                block_end_index += 1;
                continue;
            }
            break;
        }

        let occurrence = occurrence_by_label.get(label).copied().unwrap_or(0) + 1;
        occurrence_by_label.insert(label.to_string(), occurrence);

        definitions.push(FootnoteDefinition {
            label: label.to_string(),
            occurrence,
            block_start_byte: lines[index].start_byte,
            block_end_byte: lines[block_end_index].end_byte,
        });

        index = block_end_index + 1;
    }

    definitions
}

fn parse_footnote_definition_line(line: &str) -> Option<&str> {
    let indent_bytes = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent_bytes > 3 {
        return None;
    }

    let rest = &line[indent_bytes..];
    if !rest.starts_with("[^") {
        return None;
    }

    let closing_bracket = rest.find("]:")?;
    let label = &rest[2..closing_bracket];
    if label.is_empty() {
        return None;
    }

    Some(label)
}

fn is_footnote_definition_token(content: &str, token_start: usize, token_end: usize) -> bool {
    if content.as_bytes().get(token_end) != Some(&b':') {
        return false;
    }

    let line_start = content[..token_start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    content[line_start..token_start]
        .bytes()
        .all(|byte| byte == b' ')
        && token_start - line_start <= 3
}

fn collect_line_infos(content: &str) -> Vec<LineInfo<'_>> {
    let mut lines = Vec::new();
    let mut start_byte = 0usize;

    for raw_line in content.split_inclusive('\n') {
        let body = raw_line
            .strip_suffix('\n')
            .unwrap_or(raw_line)
            .strip_suffix('\r')
            .unwrap_or_else(|| raw_line.strip_suffix('\n').unwrap_or(raw_line));
        let end_byte = start_byte + body.len();

        lines.push(LineInfo {
            body,
            start_byte,
            end_byte,
        });

        start_byte += raw_line.len();
    }

    if content.is_empty() {
        lines.push(LineInfo {
            body: "",
            start_byte: 0,
            end_byte: 0,
        });
    }

    lines
}

struct FootnoteReference {
    label: String,
    occurrence: usize,
    start_byte: usize,
    end_byte: usize,
    token: String,
}

struct FootnoteDefinition {
    label: String,
    occurrence: usize,
    block_start_byte: usize,
    block_end_byte: usize,
}

struct LineInfo<'a> {
    body: &'a str,
    start_byte: usize,
    end_byte: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", next_id("test").unwrap()))
    }

    fn pending_updated_document_proposal(
        id: &str,
        document: &DocumentRecord,
        updated_document_text: &str,
        thread_ids: Vec<String>,
        resolve_thread_ids: Vec<String>,
    ) -> ProposalRecord {
        ProposalRecord {
            schema_version: 1,
            id: id.into(),
            document_id: document.id.clone(),
            thread_ids,
            adapter_id: "test".into(),
            created_at: "2026-06-11T00:00:00Z".into(),
            updated_at: "2026-06-11T00:00:00Z".into(),
            status: "pending".into(),
            base_content_hash: document.current_content_hash.clone(),
            response_mode: "updated_document".into(),
            summary: "Update proposal".into(),
            assistant_message: "Change the document.".into(),
            updated_document_text: Some(updated_document_text.into()),
            unified_diff: None,
            computed_diff: String::new(),
            warnings: Vec::new(),
            resolve_thread_ids,
            stderr: None,
            error_message: None,
        }
    }

    #[test]
    fn create_reply_delete_and_resolve_thread_round_trip() {
        let root = unique_temp_dir("margent-cli-workspace");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nHello world.\nSecond line.\n").expect("write doc");

        ensure_workspace_layout(&root).expect("init layout");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document = upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let anchor =
            build_anchor_from_quote(&document, &content, "world", 1).expect("build anchor");
        let thread = create_thread(
            &root,
            &document,
            "",
            "Make this opening more specific.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("create thread");

        let replied = add_thread_message(
            &root,
            &thread.id,
            "Working on it.",
            "reply",
            "agent",
            "Codex",
            Some("codex"),
            Some(&thread.messages[0].id),
        )
        .expect("add reply");
        assert_eq!(replied.messages.len(), 2);
        assert_eq!(
            replied.messages[1].reply_to_message_id.as_deref(),
            Some(thread.messages[0].id.as_str())
        );

        let after_delete = delete_thread_message(&root, &thread.id, 1)
            .expect("delete message")
            .expect("thread remains after delete");
        assert_eq!(after_delete.messages.len(), 1);
        assert_eq!(after_delete.messages[0].reply_to_message_id, None);

        let resolved = resolve_thread(&root, &thread.id).expect("resolve thread");
        assert_eq!(resolved.status, "resolved");

        let reopened = reopen_thread(&root, &thread.id).expect("reopen thread");
        assert_eq!(reopened.status, "open");

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn create_thread_tags_document_anchors() {
        let root = unique_temp_dir("margent-cli-document-anchor-tag");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nWhole document.\n").expect("write doc");
        ensure_workspace_layout(&root).expect("init layout");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document = upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let thread = create_thread(
            &root,
            &document,
            "Document comment",
            "Review the whole draft.",
            AnchorRecord {
                quote: "Entire document: draft.md".into(),
                prefix_context: String::new(),
                suffix_context: String::new(),
                start_offset_utf16: 0,
                end_offset_utf16: 0,
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 1,
                heading_path: Vec::new(),
                block_fingerprint: String::new(),
                base_content_hash: content_hash(&content),
                kind: "document".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
            "user",
            "user",
            "You",
            None,
        )
        .expect("create document thread");

        assert!(thread.tags.contains(&"document".to_string()));

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn load_all_threads_sorted_skips_corrupt_sibling_sidecar() {
        let root = unique_temp_dir("margent-cli-corrupt-thread-sibling");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nHello world.\n").expect("write doc");
        let md = ensure_workspace_layout(&root).expect("init layout");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document = upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let anchor =
            build_anchor_from_quote(&document, &content, "world", 1).expect("build anchor");
        let thread = create_thread(
            &root,
            &document,
            "World",
            "Tighten this phrase.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("create thread");
        fs::write(
            md.join("threads").join("thread_corrupt.json"),
            "{ not valid json",
        )
        .expect("write corrupt thread");

        let threads = load_all_threads_sorted(&root).expect("load threads");

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, thread.id);

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn load_all_documents_skips_corrupt_sibling_sidecar() {
        let root = unique_temp_dir("margent-cli-corrupt-document-sibling");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nHello world.\n").expect("write doc");
        let md = ensure_workspace_layout(&root).expect("init layout");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document = upsert_document_record(&root, "draft.md", &content).expect("index doc");
        fs::write(
            md.join("documents").join("doc_corrupt.json"),
            "{ not valid json",
        )
        .expect("write corrupt document");

        let documents = load_all_documents(&root).expect("load documents");

        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].id, document.id);

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn load_all_proposals_skips_corrupt_sibling_sidecar() {
        let root = unique_temp_dir("margent-cli-corrupt-proposal-sibling");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nHello world.\n").expect("write doc");
        let md = ensure_workspace_layout(&root).expect("init layout");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document = upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let proposal = pending_updated_document_proposal(
            "proposal_valid",
            &document,
            "# Draft\n\nHello brave world.\n",
            Vec::new(),
            Vec::new(),
        );
        save_proposal(&root, &proposal).expect("save proposal");
        fs::write(
            md.join("proposals").join("proposal_corrupt.json"),
            "{ not valid json",
        )
        .expect("write corrupt proposal");

        let proposals = load_all_proposals(&root).expect("load proposals");

        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].id, proposal.id);

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn add_thread_message_upgrades_legacy_thread_records_on_write() {
        let root = unique_temp_dir("margent-cli-legacy-thread");
        fs::create_dir_all(&root).expect("create temp root");

        let md = ensure_workspace_layout(&root).expect("init layout");
        let legacy_thread_id = "thread_legacy";
        let path = md.join("threads").join(format!("{legacy_thread_id}.json"));

        fs::write(
            &path,
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "id": legacy_thread_id,
                "documentId": "doc_legacy",
                "status": "open",
                "createdAt": "2026-03-20T12:00:00Z",
                "updatedAt": "2026-03-20T12:00:00Z",
                "createdBy": "user",
                "title": "Legacy thread",
                "tags": [],
                "anchor": {
                    "quote": "legacy",
                    "prefixContext": "",
                    "suffixContext": "",
                    "startOffsetUtf16": 0,
                    "endOffsetUtf16": 6,
                    "startLine": 1,
                    "startColumn": 1,
                    "endLine": 1,
                    "endColumn": 7,
                    "headingPath": [],
                    "blockFingerprint": "sha256:legacy",
                    "baseContentHash": "sha256:legacy",
                    "state": "attached",
                    "confidence": 1.0
                },
                "messages": [{
                    "id": "msg_legacy",
                    "threadId": legacy_thread_id,
                    "authorType": "user",
                    "authorName": "You",
                    "agentId": null,
                    "adapterId": null,
                    "replyToMessageId": null,
                    "createdAt": "2026-03-20T12:00:00Z",
                    "body": "Legacy body",
                    "kind": "comment"
                }],
                "linkedProposalIds": []
            }))
            .expect("serialize legacy thread"),
        )
        .expect("write legacy thread");

        let updated = add_thread_message(
            &root,
            legacy_thread_id,
            "Upgraded reply",
            "reply",
            "user",
            "You",
            None,
            None,
        )
        .expect("reply to legacy thread");

        assert_eq!(updated.schema_version, CURRENT_THREAD_SCHEMA_VERSION);
        assert_eq!(updated.anchor.kind, "text_span");

        let persisted = load_thread(&root, legacy_thread_id).expect("load upgraded thread");
        assert_eq!(persisted.schema_version, CURRENT_THREAD_SCHEMA_VERSION);
        assert_eq!(persisted.anchor.kind, "text_span");
        assert_eq!(persisted.messages.len(), 2);

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn migrate_legacy_thread_records_updates_only_legacy_threads() {
        let root = unique_temp_dir("margent-cli-migrate");
        fs::create_dir_all(&root).expect("create temp root");

        let md = ensure_workspace_layout(&root).expect("init layout");
        let legacy_thread_id = "thread_legacy";
        let legacy_path = md.join("threads").join(format!("{legacy_thread_id}.json"));

        fs::write(
            &legacy_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "id": legacy_thread_id,
                "documentId": "doc_legacy",
                "status": "open",
                "createdAt": "2026-03-20T12:00:00Z",
                "updatedAt": "2026-03-20T12:00:00Z",
                "createdBy": "user",
                "title": "Legacy thread",
                "tags": [],
                "anchor": {
                    "quote": "legacy",
                    "prefixContext": "",
                    "suffixContext": "",
                    "startOffsetUtf16": 0,
                    "endOffsetUtf16": 6,
                    "startLine": 1,
                    "startColumn": 1,
                    "endLine": 1,
                    "endColumn": 7,
                    "headingPath": [],
                    "blockFingerprint": "sha256:legacy",
                    "baseContentHash": "sha256:legacy",
                    "state": "attached",
                    "confidence": 1.0
                },
                "messages": [],
                "linkedProposalIds": []
            }))
            .expect("serialize legacy thread"),
        )
        .expect("write legacy thread");

        let current_thread = ThreadRecord {
            schema_version: CURRENT_THREAD_SCHEMA_VERSION,
            id: "thread_current".into(),
            document_id: "doc_current".into(),
            status: "open".into(),
            created_at: "2026-03-20T12:00:00Z".into(),
            updated_at: "2026-03-20T12:00:00Z".into(),
            created_by: "user".into(),
            title: "Current thread".into(),
            tags: Vec::new(),
            anchor: AnchorRecord {
                quote: "current".into(),
                prefix_context: String::new(),
                suffix_context: String::new(),
                start_offset_utf16: 0,
                end_offset_utf16: 7,
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 8,
                heading_path: Vec::new(),
                block_fingerprint: "sha256:current".into(),
                base_content_hash: "sha256:current".into(),
                kind: "text_span".into(),
                footnote: None,
                state: "attached".into(),
                confidence: 1.0,
            },
            created_content_hash: Some("sha256:current".into()),
            last_reanchor_content_hash: Some("sha256:current".into()),
            review_round: None,
            review_done: false,
            messages: Vec::new(),
            linked_proposal_ids: Vec::new(),
            provider_sessions: std::collections::HashMap::new(),
        };
        save_thread(&root, &current_thread).expect("save current thread");

        let (total, migrated) =
            migrate_legacy_thread_records(&root).expect("migrate legacy thread records");

        assert_eq!(total, 2);
        assert_eq!(migrated, 1);

        let persisted_legacy = load_thread(&root, legacy_thread_id).expect("load legacy thread");
        assert_eq!(
            persisted_legacy.schema_version,
            CURRENT_THREAD_SCHEMA_VERSION
        );
        assert_eq!(persisted_legacy.anchor.kind, "text_span");

        let persisted_current = load_thread(&root, "thread_current").expect("load current thread");
        assert_eq!(
            persisted_current.schema_version,
            CURRENT_THREAD_SCHEMA_VERSION
        );
        assert_eq!(persisted_current.anchor.kind, "text_span");

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn save_document_updates_indexed_hash() {
        let root = unique_temp_dir("margent-cli-save");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "Hello world.\n").expect("write doc");
        ensure_workspace_layout(&root).expect("init layout");
        let original = upsert_document_record(&root, "draft.md", "Hello world.\n").expect("index");

        let updated = save_document(&root, "draft.md", "Hello universe.\n").expect("save doc");

        assert_ne!(updated.current_content_hash, original.current_content_hash);
        assert_eq!(
            fs::read_to_string(&document_path).expect("read updated doc"),
            "Hello universe.\n"
        );

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn accept_proposal_records_authorship_spans() {
        let root = unique_temp_dir("margent-cli-authorship");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "Hello world\nSecond line\n").expect("write doc");
        ensure_workspace_layout(&root).expect("init layout");
        let document =
            upsert_document_record(&root, "draft.md", "Hello world\nSecond line\n").expect("index");
        let updated = "Hello brave world\nSecond line\n";
        let proposal = ProposalRecord {
            schema_version: 1,
            id: "proposal_authorship".into(),
            document_id: document.id.clone(),
            thread_ids: Vec::new(),
            adapter_id: "codex".into(),
            created_at: "2026-06-11T00:00:00Z".into(),
            updated_at: "2026-06-11T00:00:00Z".into(),
            status: "pending".into(),
            base_content_hash: document.current_content_hash.clone(),
            response_mode: "updated_document".into(),
            summary: "Add specificity".into(),
            assistant_message: "Inserted a sharpening adjective.".into(),
            updated_document_text: Some(updated.into()),
            unified_diff: None,
            computed_diff: compute_unified_diff("Hello world\nSecond line\n", updated),
            warnings: Vec::new(),
            resolve_thread_ids: Vec::new(),
            stderr: None,
            error_message: None,
        };
        save_proposal(&root, &proposal).expect("save proposal");

        let result = accept_proposal(&root, &proposal.id, None).expect("accept proposal");

        assert_eq!(result.proposal.status, "accepted");
        assert_eq!(
            fs::read_to_string(&document_path).expect("read accepted doc"),
            updated
        );
        let path = root
            .join(".mdreview")
            .join("authorship")
            .join(format!("{}.json", document.id));
        let authorship = read_json::<margent_core::authorship::AuthorshipMapRecord>(&path)
            .expect("read authorship")
            .expect("authorship record");
        assert_eq!(authorship.content_hash, content_hash(updated));
        assert_eq!(authorship.spans.len(), 1);
        assert_eq!(authorship.spans[0].quote, "brave ");
        assert_eq!(authorship.spans[0].source.proposal_id, proposal.id);
        assert_eq!(
            authorship.spans[0].source.agent_id.as_deref(),
            Some("codex")
        );

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn accept_proposal_creates_snapshot_of_previous_document() {
        let root = unique_temp_dir("margent-cli-accept-snapshot");
        fs::create_dir_all(&root).expect("create temp root");

        let before = "Hello world\nSecond line\n";
        let updated = "Hello brave world\nSecond line\n";
        let document_path = root.join("draft.md");
        fs::write(&document_path, before).expect("write doc");
        ensure_workspace_layout(&root).expect("init layout");
        let document = upsert_document_record(&root, "draft.md", before).expect("index doc");
        let mut proposal = pending_updated_document_proposal(
            "proposal_snapshot",
            &document,
            updated,
            vec![],
            vec![],
        );
        proposal.computed_diff = compute_unified_diff(before, updated);
        save_proposal(&root, &proposal).expect("save proposal");

        let result = accept_proposal(&root, &proposal.id, None).expect("accept proposal");

        assert_eq!(result.proposal.status, "accepted");
        let updated_hash = content_hash(updated);
        assert_eq!(
            result
                .document
                .as_ref()
                .map(|document| document.current_content_hash.as_str()),
            Some(updated_hash.as_str())
        );
        assert_eq!(
            fs::read_to_string(&document_path).expect("read accepted doc"),
            updated
        );

        let snapshot = result.snapshot.expect("accept returns snapshot");
        assert_eq!(snapshot.document_id, document.id);
        assert_eq!(snapshot.relative_path, "draft.md");
        assert_eq!(snapshot.content, before);
        assert_eq!(snapshot.content_hash, content_hash(before));
        assert_eq!(snapshot.reason, "proposal.accept");
        assert_eq!(snapshot.proposal_id.as_deref(), Some(proposal.id.as_str()));

        let persisted_snapshot_path = root
            .join(".mdreview")
            .join("snapshots")
            .join(format!("{}.json", snapshot.id));
        let persisted_snapshot = read_json::<DocumentSnapshotRecord>(&persisted_snapshot_path)
            .expect("read persisted snapshot")
            .expect("persisted snapshot");
        assert_eq!(persisted_snapshot.id, snapshot.id);
        assert_eq!(persisted_snapshot.content, before);

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn accept_proposal_resolves_resolve_thread_ids() {
        let root = unique_temp_dir("margent-cli-resolve-thread");
        fs::create_dir_all(&root).expect("create temp root");

        let before = "# Draft\n\nHello world.\n";
        let updated = "# Draft\n\nHello brave world.\n";
        let document_path = root.join("draft.md");
        fs::write(&document_path, before).expect("write doc");
        ensure_workspace_layout(&root).expect("init layout");
        let document = upsert_document_record(&root, "draft.md", before).expect("index doc");
        let anchor = build_anchor_from_quote(&document, before, "world", 1).expect("build anchor");
        let thread = create_thread(
            &root,
            &document,
            "World",
            "Make this less generic.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("create thread");
        let proposal = pending_updated_document_proposal(
            "proposal_deferred_resolve",
            &document,
            updated,
            vec![thread.id.clone()],
            vec![thread.id.clone(), "thread_missing".into()],
        );
        save_proposal(&root, &proposal).expect("save proposal");

        let result = accept_proposal(&root, &proposal.id, None).expect("accept proposal");

        assert_eq!(result.proposal.status, "accepted");
        assert_eq!(
            result.proposal.resolve_thread_ids,
            vec![thread.id.clone(), "thread_missing".into()]
        );
        assert_eq!(
            fs::read_to_string(&document_path).expect("read accepted doc"),
            updated
        );
        let resolved_thread = load_thread(&root, &thread.id).expect("load thread");
        assert_eq!(resolved_thread.status, "resolved");

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn delete_markdown_file_snapshots_and_revert_restores_by_path() {
        let root = unique_temp_dir("margent-cli-delete-revert");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nOriginal body.\n").expect("write doc");
        ensure_workspace_layout(&root).expect("init layout");
        let document = upsert_document_record(&root, "draft.md", "# Draft\n\nOriginal body.\n")
            .expect("index doc");

        let deleted = delete_markdown_file(&root, "draft.md").expect("delete document");
        assert_eq!(deleted.id, document.id);
        assert!(!document_path.exists());
        assert!(load_document_by_id(&root, &document.id).is_err());

        let (snapshot, restored) =
            revert_latest_snapshot(&root, Some("draft.md")).expect("revert latest snapshot");

        assert_eq!(snapshot.reason, "delete");
        assert_eq!(restored.relative_path, "draft.md");
        assert_eq!(
            fs::read_to_string(&document_path).expect("read restored doc"),
            "# Draft\n\nOriginal body.\n"
        );
        assert_eq!(
            load_document_by_id(&root, &document.id)
                .expect("load restored document")
                .current_content_hash,
            content_hash("# Draft\n\nOriginal body.\n")
        );

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn accept_proposal_rejects_hash_mismatch_and_marks_stale() {
        let root = unique_temp_dir("margent-cli-stale-proposal");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "Original text.\n").expect("write doc");
        ensure_workspace_layout(&root).expect("init layout");
        let document =
            upsert_document_record(&root, "draft.md", "Original text.\n").expect("index doc");

        let proposal = ProposalRecord {
            schema_version: 1,
            id: "proposal_stale".into(),
            document_id: document.id.clone(),
            thread_ids: Vec::new(),
            adapter_id: "test".into(),
            created_at: "2026-06-11T00:00:00Z".into(),
            updated_at: "2026-06-11T00:00:00Z".into(),
            status: "pending".into(),
            base_content_hash: document.current_content_hash.clone(),
            response_mode: "updated_document".into(),
            summary: "Update proposal".into(),
            assistant_message: "Change the document.".into(),
            updated_document_text: Some("Accepted text.\n".into()),
            unified_diff: None,
            computed_diff: String::new(),
            warnings: Vec::new(),
            resolve_thread_ids: Vec::new(),
            stderr: None,
            error_message: None,
        };
        save_proposal(&root, &proposal).expect("save proposal");
        save_document(&root, "draft.md", "Human edit first.\n").expect("change document");

        let error =
            accept_proposal(&root, &proposal.id, None).expect_err("hash mismatch should fail");
        assert!(error.contains("marked stale"));

        let stale = load_proposal(&root, &proposal.id).expect("load stale proposal");
        assert_eq!(stale.status, "stale");
        assert!(stale
            .warnings
            .iter()
            .any(|warning| warning.contains("older saved document hash")));
        assert_eq!(
            fs::read_to_string(&document_path).expect("read unchanged doc"),
            "Human edit first.\n"
        );
        let snapshot_count = fs::read_dir(root.join(".mdreview").join("snapshots"))
            .expect("read snapshots")
            .count();
        assert_eq!(snapshot_count, 0);

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn resolve_thread_by_id_requires_matching_document() {
        let root = unique_temp_dir("margent-cli-thread-id");
        fs::create_dir_all(&root).expect("create temp root");

        let document_path = root.join("draft.md");
        fs::write(&document_path, "# Draft\n\nHello world.\n").expect("write doc");

        ensure_workspace_layout(&root).expect("init layout");
        let content = fs::read_to_string(&document_path).expect("read doc");
        let document = upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let anchor =
            build_anchor_from_quote(&document, &content, "world", 1).expect("build anchor");
        let thread = create_thread(
            &root, &document, "", "Comment", anchor, "user", "user", "You", None,
        )
        .expect("create thread");

        let resolved =
            resolve_thread_by_id(&root, &document.id, &thread.id).expect("resolve by id");
        assert_eq!(resolved.id, thread.id);

        let err = resolve_thread_by_id(&root, "doc_other", &thread.id)
            .expect_err("document mismatch should fail");
        assert!(err.contains("does not belong to document"));

        fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn extract_and_replace_anchor_text_uses_utf16_offsets() {
        let content = "Intro\n\nTarget paragraph.\n\nOutro\n";
        let start_offset_utf16 = content.find("Target paragraph.").expect("target start");
        let end_offset_utf16 = start_offset_utf16 + "Target paragraph.".encode_utf16().count();
        let anchor = AnchorRecord {
            quote: "Target paragraph.".into(),
            prefix_context: String::new(),
            suffix_context: String::new(),
            start_offset_utf16,
            end_offset_utf16,
            start_line: 3,
            start_column: 1,
            end_line: 3,
            end_column: 18,
            heading_path: Vec::new(),
            block_fingerprint: String::new(),
            base_content_hash: String::new(),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        };

        let extracted = extract_anchor_text(content, &anchor).expect("extract anchor text");
        assert_eq!(extracted, "Target paragraph.");

        let replaced = replace_anchor_text(content, &anchor, "Expanded paragraph.")
            .expect("replace anchor text");
        assert_eq!(replaced, "Intro\n\nExpanded paragraph.\n\nOutro\n");
    }

    #[test]
    fn build_anchor_from_quote_marks_exact_footnote_reference_tokens() {
        let content = "Alpha[^a] and beta[^a].\n\n[^a]: shared note\n";
        let document = DocumentRecord {
            schema_version: 1,
            id: "doc_test".into(),
            relative_path: "draft.md".into(),
            display_name: "draft.md".into(),
            created_at: "2026-03-20T00:00:00Z".into(),
            updated_at: "2026-03-20T00:00:00Z".into(),
            current_content_hash: content_hash(content),
            last_known_line_ending: "lf".into(),
            frontmatter_mode: "none".into(),
            word_count: 4,
            heading_index: Vec::new(),
        };

        let anchor = build_anchor_from_quote(&document, content, "[^a]", 2).expect("footnote ref");

        assert_eq!(anchor.kind, "footnote_reference");
        assert_eq!(
            anchor
                .footnote
                .as_ref()
                .map(|value| (value.label.as_str(), value.occurrence)),
            Some(("a", 2))
        );
    }

    #[test]
    fn build_anchor_from_quote_keeps_sentence_level_ref_matches_as_text_spans() {
        let content = "Sentence with ref [^a] inline.\n\n[^a]: note\n";
        let document = DocumentRecord {
            schema_version: 1,
            id: "doc_test".into(),
            relative_path: "draft.md".into(),
            display_name: "draft.md".into(),
            created_at: "2026-03-20T00:00:00Z".into(),
            updated_at: "2026-03-20T00:00:00Z".into(),
            current_content_hash: content_hash(content),
            last_known_line_ending: "lf".into(),
            frontmatter_mode: "none".into(),
            word_count: 4,
            heading_index: Vec::new(),
        };

        let anchor =
            build_anchor_from_quote(&document, content, "Sentence with ref [^a] inline.", 1)
                .expect("sentence anchor");

        assert_eq!(anchor.kind, "text_span");
        assert!(anchor.footnote.is_none());
    }

    #[test]
    fn build_anchor_from_quote_marks_definition_body_matches() {
        let content = "Sentence with ref [^a].\n\n[^a]: note body\n";
        let document = DocumentRecord {
            schema_version: 1,
            id: "doc_test".into(),
            relative_path: "draft.md".into(),
            display_name: "draft.md".into(),
            created_at: "2026-03-20T00:00:00Z".into(),
            updated_at: "2026-03-20T00:00:00Z".into(),
            current_content_hash: content_hash(content),
            last_known_line_ending: "lf".into(),
            frontmatter_mode: "none".into(),
            word_count: 4,
            heading_index: Vec::new(),
        };

        let anchor = build_anchor_from_quote(&document, content, "note body", 1)
            .expect("definition body anchor");

        assert_eq!(anchor.kind, "footnote_definition");
        assert_eq!(
            anchor
                .footnote
                .as_ref()
                .map(|value| (value.label.as_str(), value.occurrence)),
            Some(("a", 1))
        );
    }
}
