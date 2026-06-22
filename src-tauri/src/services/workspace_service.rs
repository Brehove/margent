use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(not(test))]
use std::thread;
#[cfg(debug_assertions)]
use std::time::Instant;
use std::time::UNIX_EPOCH;

use crate::models::document::{
    DocumentPayload, DocumentRecord, DocumentVersion, IntoDocumentPayload,
    SaveDocumentIfCurrentResult,
};
use crate::models::proposal::ProposalRecord;
use crate::models::snapshot::{DocumentSnapshotRecord, DocumentSnapshotRevertResult};
use crate::models::thread::ThreadRecord;
use crate::models::workspace::{AssetImportResult, WorkspaceRecord, WorkspaceSnapshot};

use super::{file_service, thread_service};

const MAX_SNAPSHOTS_PER_DOCUMENT: usize = 50;

#[cfg(debug_assertions)]
struct DebugTiming {
    label: &'static str,
    start: Instant,
}

#[cfg(not(debug_assertions))]
struct DebugTiming;

impl DebugTiming {
    #[cfg(debug_assertions)]
    fn new(label: &'static str) -> Self {
        Self {
            label,
            start: Instant::now(),
        }
    }

    #[cfg(not(debug_assertions))]
    fn new(_label: &'static str) -> Self {
        Self
    }

    #[cfg(debug_assertions)]
    fn mark(&self, step: &str) {
        eprintln!(
            "[margent timing] {}: {} at {:.1}ms",
            self.label,
            step,
            self.start.elapsed().as_secs_f64() * 1000.0
        );
    }

    #[cfg(not(debug_assertions))]
    fn mark(&self, _step: &str) {}
}

pub fn open_workspace(path: &str) -> Result<WorkspaceSnapshot, String> {
    let (root_path, opened_path) = file_service::resolve_workspace_root(Path::new(path))?;
    let mdreview_path = file_service::ensure_workspace_layout(&root_path)?;
    sync_workspace_record(&root_path, &mdreview_path)?;

    let mut documents = Vec::new();
    let mut selected_relative_path = None;
    let markdown_files = file_service::list_markdown_files(&root_path)?;
    let selected_markdown_file = opened_path
        .clone()
        .or_else(|| markdown_files.first().cloned());

    for markdown_file in markdown_files {
        let relative_path = file_service::relative_path_string(&root_path, &markdown_file)?;

        let record = if selected_markdown_file.as_ref() == Some(&markdown_file) {
            selected_relative_path = Some(relative_path.clone());
            let content = fs::read_to_string(&markdown_file)
                .map_err(|error| format!("Unable to read {}: {error}", markdown_file.display()))?;
            upsert_document_record(&root_path, &relative_path, &content)?
        } else {
            summarize_document_without_content(&relative_path, &markdown_file)?
        };
        documents.push(record);
    }

    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    Ok(WorkspaceSnapshot {
        root_path: root_path.to_string_lossy().to_string(),
        opened_path: opened_path.map(|path| path.to_string_lossy().to_string()),
        mdreview_path: mdreview_path.to_string_lossy().to_string(),
        selected_relative_path,
        documents,
    })
}

pub fn read_document(workspace_root: &str, relative_path: &str) -> Result<DocumentPayload, String> {
    let root_path = Path::new(workspace_root);
    let document_path = file_service::resolve_document_path(root_path, relative_path)?;
    let (content, version) = read_document_content_and_version(&document_path)?;
    let record = upsert_document_record(root_path, relative_path, &content)?;

    Ok(record.into_payload(
        document_path.to_string_lossy().to_string(),
        content,
        version,
    ))
}

pub(crate) fn hydrate_document_record_by_id(
    root_path: &Path,
    document_id: &str,
) -> Result<Option<DocumentRecord>, String> {
    if let Some(record) = read_document_record(root_path, document_id)? {
        return Ok(Some(record));
    }

    for markdown_file in file_service::list_markdown_files(root_path)? {
        let relative_path = file_service::relative_path_string(root_path, &markdown_file)?;
        if file_service::document_id(&relative_path) != document_id {
            continue;
        }

        return hydrate_document_record_by_relative_path(root_path, &relative_path).map(Some);
    }

    Ok(None)
}

pub(crate) fn hydrate_document_record_by_relative_path(
    root_path: &Path,
    relative_path: &str,
) -> Result<DocumentRecord, String> {
    let document_path = file_service::resolve_document_path(root_path, relative_path)?;
    let content = fs::read_to_string(&document_path)
        .map_err(|error| format!("Unable to read {}: {error}", document_path.display()))?;

    upsert_document_record(root_path, relative_path, &content)
}

pub fn create_markdown_file(
    workspace_root: &str,
    relative_path: &str,
    content: Option<&str>,
) -> Result<DocumentPayload, String> {
    let root_path = Path::new(workspace_root);
    let document_path = file_service::resolve_new_document_path(root_path, relative_path)?;

    if document_path.exists() {
        return Err(format!("{relative_path} already exists."));
    }

    let content = content.unwrap_or_default();
    file_service::write_string_atomic(&document_path, content)?;
    let normalized_relative_path = file_service::relative_path_string(
        &root_path.canonicalize().map_err(|error| {
            format!(
                "Unable to resolve workspace root {}: {error}",
                root_path.display()
            )
        })?,
        &document_path,
    )?;
    let record = upsert_document_record(root_path, &normalized_relative_path, content)?;
    let version = document_version_for_path_and_content(&document_path, content)?;

    thread_service::append_event(
        root_path,
        "document.created",
        None,
        Some(&record.id),
        None,
        Some(&normalized_relative_path),
    )?;

    Ok(record.into_payload(
        document_path.to_string_lossy().to_string(),
        content.to_string(),
        version,
    ))
}

pub fn rename_markdown_file(
    workspace_root: &str,
    from_relative_path: &str,
    to_relative_path: &str,
) -> Result<DocumentPayload, String> {
    if from_relative_path == to_relative_path {
        return Err("Choose a different path for the renamed document.".into());
    }

    let root_path = Path::new(workspace_root);
    let from_path = file_service::resolve_document_path(root_path, from_relative_path)?;
    let to_path = file_service::resolve_new_document_path(root_path, to_relative_path)?;
    let from_id = file_service::document_id(from_relative_path);
    let old_record = read_document_record(root_path, &from_id)?;

    rename_document_file(&from_path, &to_path, to_relative_path)?;

    let (content, version) = read_document_content_and_version(&to_path)?;
    let normalized_to_relative_path = file_service::relative_path_string(
        &root_path.canonicalize().map_err(|error| {
            format!(
                "Unable to resolve workspace root {}: {error}",
                root_path.display()
            )
        })?,
        &to_path,
    )?;
    let to_id = file_service::document_id(&normalized_to_relative_path);
    let record = write_document_record(
        root_path,
        &normalized_to_relative_path,
        &content,
        old_record
            .as_ref()
            .map(|record| record.created_at.clone())
            .as_deref(),
    )?;

    if from_id != to_id {
        remove_document_record(root_path, &from_id)?;
        retarget_document_sidecars(root_path, &from_id, &to_id)?;
    }

    thread_service::append_event(
        root_path,
        "document.renamed",
        None,
        Some(&record.id),
        None,
        Some(&format!(
            "{from_relative_path} -> {normalized_to_relative_path}"
        )),
    )?;

    Ok(record.into_payload(to_path.to_string_lossy().to_string(), content, version))
}

pub fn delete_markdown_file(
    workspace_root: &str,
    relative_path: &str,
) -> Result<WorkspaceSnapshot, String> {
    let root_path = Path::new(workspace_root);
    let document_path = file_service::resolve_document_path(root_path, relative_path)?;
    let document_id = file_service::document_id(relative_path);

    if !document_path.is_file() {
        return Err(format!("{relative_path} is not a Markdown file."));
    }

    let content = fs::read_to_string(&document_path)
        .map_err(|error| format!("Unable to read {}: {error}", document_path.display()))?;
    let document_record = upsert_document_record(root_path, relative_path, &content)?;
    snapshot_document(root_path, &document_record, &content, "delete", None)?;

    fs::remove_file(&document_path)
        .map_err(|error| format!("Unable to delete {}: {error}", document_path.display()))?;
    remove_document_record(root_path, &document_id)?;
    remove_document_sidecars(root_path, &document_id)?;

    thread_service::append_event(
        root_path,
        "document.deleted",
        None,
        Some(&document_id),
        None,
        Some(relative_path),
    )?;

    open_workspace(workspace_root)
}

pub fn snapshot_document(
    root_path: &Path,
    document: &DocumentRecord,
    content: &str,
    reason: &str,
    proposal_id: Option<&str>,
) -> Result<DocumentSnapshotRecord, String> {
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let snapshot_id = margent_core::id::new_id("snapshot");
    let created_at = file_service::now_rfc3339()?;
    let record = DocumentSnapshotRecord {
        id: snapshot_id.clone(),
        document_id: document.id.clone(),
        relative_path: document.relative_path.clone(),
        content_hash: file_service::content_hash(content),
        content: content.to_string(),
        created_at,
        reason: reason.to_string(),
        proposal_id: proposal_id.map(str::to_string),
    };
    let snapshot_path = mdreview_path
        .join("snapshots")
        .join(format!("{snapshot_id}.json"));
    file_service::write_json_atomic(&snapshot_path, &record)?;
    prune_document_snapshots(&mdreview_path, &document.id)?;
    Ok(record)
}

pub fn list_document_snapshots(
    workspace_root: &str,
    relative_path: Option<&str>,
) -> Result<Vec<DocumentSnapshotRecord>, String> {
    let root_path = Path::new(workspace_root);
    let normalized_relative_path = relative_path
        .map(|path| normalize_document_relative_path(root_path, path))
        .transpose()?;
    list_document_snapshots_for_root(root_path, normalized_relative_path.as_deref())
}

pub fn revert_latest_snapshot(
    workspace_root: &str,
    relative_path: Option<&str>,
) -> Result<DocumentSnapshotRevertResult, String> {
    let root_path = Path::new(workspace_root);
    let snapshot = load_latest_snapshot(root_path, relative_path)?;
    let document_path =
        file_service::resolve_new_document_path(root_path, &snapshot.relative_path)?;
    let parent = document_path.parent().ok_or_else(|| {
        format!(
            "Unable to derive the parent directory for {}.",
            snapshot.relative_path
        )
    })?;

    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
    file_service::write_string_atomic(&document_path, &snapshot.content)?;
    let version = document_version_for_path_and_content(&document_path, &snapshot.content)?;
    let record = upsert_document_record(root_path, &snapshot.relative_path, &snapshot.content)?;
    schedule_document_thread_reattach(
        root_path.to_path_buf(),
        record.clone(),
        snapshot.content.clone(),
    );

    thread_service::append_event(
        root_path,
        "document.reverted",
        None,
        Some(&record.id),
        snapshot.proposal_id.as_deref(),
        Some(&snapshot.id),
    )?;

    let document = record.into_payload(
        document_path.to_string_lossy().to_string(),
        snapshot.content.clone(),
        version,
    );

    Ok(DocumentSnapshotRevertResult { snapshot, document })
}

fn load_latest_snapshot(
    root_path: &Path,
    relative_path: Option<&str>,
) -> Result<DocumentSnapshotRecord, String> {
    let normalized_relative_path = relative_path
        .map(|path| normalize_document_relative_path(root_path, path))
        .transpose()?;
    list_document_snapshots_for_root(root_path, normalized_relative_path.as_deref())?
        .into_iter()
        .next()
        .ok_or_else(|| "No Margent document snapshots found.".into())
}

fn list_document_snapshots_for_root(
    root_path: &Path,
    relative_path: Option<&str>,
) -> Result<Vec<DocumentSnapshotRecord>, String> {
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let snapshots_dir = mdreview_path.join("snapshots");
    let mut snapshots = Vec::new();

    for path in json_files_in_directory(&snapshots_dir)? {
        let Some(snapshot) =
            file_service::read_scanned_json::<DocumentSnapshotRecord>(&path, "snapshot")?
        else {
            continue;
        };

        if relative_path
            .map(|expected| snapshot.relative_path == expected)
            .unwrap_or(true)
        {
            snapshots.push(snapshot);
        }
    }

    snapshots.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(snapshots)
}

fn normalize_document_relative_path(
    root_path: &Path,
    relative_path: &str,
) -> Result<String, String> {
    let document_path = file_service::resolve_new_document_path(root_path, relative_path)?;
    let canonical_root = root_path.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace root {}: {error}",
            root_path.display()
        )
    })?;
    file_service::relative_path_string(&canonical_root, &document_path)
}

fn prune_document_snapshots(mdreview_path: &Path, document_id: &str) -> Result<(), String> {
    let snapshots_dir = mdreview_path.join("snapshots");
    let mut snapshots = Vec::new();

    for entry in fs::read_dir(&snapshots_dir)
        .map_err(|error| format!("Unable to read {}: {error}", snapshots_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to inspect snapshot records: {error}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(snapshot) =
            file_service::read_scanned_json::<DocumentSnapshotRecord>(&path, "snapshot")?
        else {
            continue;
        };

        if snapshot.document_id == document_id {
            snapshots.push((snapshot.created_at, snapshot.id, path));
        }
    }

    snapshots.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));

    for (_, _, path) in snapshots.into_iter().skip(MAX_SNAPSHOTS_PER_DOCUMENT) {
        remove_file_if_exists(&path)?;
    }

    Ok(())
}

pub fn reveal_markdown_file(workspace_root: &str, relative_path: &str) -> Result<(), String> {
    let root_path = Path::new(workspace_root);
    let document_path = file_service::resolve_document_path(root_path, relative_path)?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&document_path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", document_path.display()));
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(document_path.parent().unwrap_or(root_path));
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to reveal {relative_path}: {error}"))
}

pub fn check_document_update(
    workspace_root: &str,
    relative_path: &str,
    known_content_hash: &str,
) -> Result<Option<DocumentPayload>, String> {
    let root_path = Path::new(workspace_root);
    let document_path = file_service::resolve_document_path(root_path, relative_path)?;
    let (content, version) = read_document_content_and_version(&document_path)?;
    let current_content_hash = version.content_hash.clone();

    if current_content_hash == known_content_hash {
        return Ok(None);
    }

    let record = upsert_document_record(root_path, relative_path, &content)?;
    Ok(Some(record.into_payload(
        document_path.to_string_lossy().to_string(),
        content,
        version,
    )))
}

pub fn save_document(
    workspace_root: &str,
    relative_path: &str,
    content: &str,
) -> Result<DocumentPayload, String> {
    save_document_with_reattach(
        workspace_root,
        relative_path,
        content,
        ReattachMode::Blocking,
        "save_document",
    )
}

pub fn save_document_after_proposal_accept(
    workspace_root: &str,
    relative_path: &str,
    content: &str,
) -> Result<DocumentPayload, String> {
    save_document_with_reattach(
        workspace_root,
        relative_path,
        content,
        ReattachMode::Deferred,
        "save_document_after_proposal_accept",
    )
}

fn save_document_with_reattach(
    workspace_root: &str,
    relative_path: &str,
    content: &str,
    reattach_mode: ReattachMode,
    timing_label: &'static str,
) -> Result<DocumentPayload, String> {
    let timing = DebugTiming::new(timing_label);
    let root_path = Path::new(workspace_root);
    let document_path = file_service::resolve_document_path(root_path, relative_path)?;
    timing.mark("resolve path");
    file_service::write_string_atomic(&document_path, content)?;
    timing.mark("write file");
    let version = document_version_for_path_and_content(&document_path, content)?;
    timing.mark("document version");
    let record = upsert_document_record(root_path, relative_path, content)?;
    timing.mark("upsert document record");
    match reattach_mode {
        ReattachMode::Blocking => {
            thread_service::reattach_document_threads(root_path, &record, content)?;
            timing.mark("reattach threads");
        }
        ReattachMode::Deferred => {
            schedule_document_thread_reattach(
                root_path.to_path_buf(),
                record.clone(),
                content.to_string(),
            );
            timing.mark("schedule reattach threads");
        }
    }

    Ok(record.into_payload(
        document_path.to_string_lossy().to_string(),
        content.to_string(),
        version,
    ))
}

#[derive(Clone, Copy)]
enum ReattachMode {
    Blocking,
    Deferred,
}

fn schedule_document_thread_reattach(
    root_path: PathBuf,
    document_record: DocumentRecord,
    content: String,
) {
    #[cfg(test)]
    {
        let _ = reattach_document_threads_if_current(&root_path, &document_record, &content);
    }

    #[cfg(not(test))]
    {
        let document_id = document_record.id.clone();
        #[cfg(debug_assertions)]
        let spawned_document_id = document_id.clone();
        let thread_name = format!("margent-reattach-{document_id}");
        if let Err(error) = thread::Builder::new().name(thread_name).spawn(move || {
            #[cfg(debug_assertions)]
            let start = Instant::now();
            let result =
                reattach_document_threads_if_current(&root_path, &document_record, &content);
            #[cfg(debug_assertions)]
            match result {
                Ok(()) => eprintln!(
                "[margent timing] deferred reattach_document_threads: document={}, elapsed={:.1}ms",
                spawned_document_id,
                start.elapsed().as_secs_f64() * 1000.0
            ),
                Err(error) => eprintln!(
                "[margent timing] deferred reattach_document_threads failed: document={}, error={}",
                spawned_document_id, error
            ),
            }
            #[cfg(not(debug_assertions))]
            let _ = result;
        }) {
            #[cfg(debug_assertions)]
            eprintln!(
            "[margent timing] deferred reattach_document_threads spawn failed: document={}, error={}",
            document_id, error
        );
            #[cfg(not(debug_assertions))]
            let _ = error;
        }
    }
}

fn reattach_document_threads_if_current(
    root_path: &Path,
    document_record: &DocumentRecord,
    content: &str,
) -> Result<(), String> {
    let Some(current_record) = read_document_record(root_path, &document_record.id)? else {
        return Ok(());
    };

    if current_record.current_content_hash != document_record.current_content_hash {
        #[cfg(debug_assertions)]
        eprintln!(
            "[margent timing] deferred reattach_document_threads skipped stale document: document={}",
            document_record.id
        );
        return Ok(());
    }

    thread_service::reattach_document_threads(root_path, document_record, content)
}

pub fn save_document_if_current(
    workspace_root: &str,
    relative_path: &str,
    content: &str,
    expected_version: &DocumentVersion,
    operation_id: &str,
) -> Result<SaveDocumentIfCurrentResult, String> {
    let root_path = Path::new(workspace_root);
    let document_path = file_service::resolve_document_path(root_path, relative_path)?;
    let (_current_content, actual_version) = read_document_content_and_version(&document_path)?;

    if &actual_version != expected_version {
        return Ok(SaveDocumentIfCurrentResult::Conflict {
            expected_version: expected_version.clone(),
            actual_version,
            operation_id: operation_id.to_string(),
        });
    }

    file_service::write_string_atomic(&document_path, content)?;
    let version = document_version_for_path_and_content(&document_path, content)?;
    let record = upsert_document_record(root_path, relative_path, content)?;
    schedule_document_thread_reattach(root_path.to_path_buf(), record.clone(), content.to_string());

    Ok(SaveDocumentIfCurrentResult::Saved {
        document: Box::new(record.into_payload(
            document_path.to_string_lossy().to_string(),
            content.to_string(),
            version,
        )),
        operation_id: operation_id.to_string(),
    })
}

pub fn import_asset(
    workspace_root: &str,
    suggested_name: &str,
    bytes: Vec<u8>,
) -> Result<AssetImportResult, String> {
    if bytes.is_empty() {
        return Err("Cannot import an empty asset.".into());
    }

    let root_path = Path::new(workspace_root);
    let canonical_root = root_path.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace root {}: {error}",
            root_path.display()
        )
    })?;
    let assets_dir = canonical_root.join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|error| format!("Unable to create {}: {error}", assets_dir.display()))?;

    let asset_name = sanitize_asset_file_name(suggested_name);
    let asset_path = next_available_asset_path(&assets_dir, &asset_name)?;
    file_service::write_bytes_atomic(&asset_path, &bytes)?;
    let relative_path = file_service::relative_path_string(&canonical_root, &asset_path)?;

    thread_service::append_event(
        &canonical_root,
        "asset.imported",
        None,
        None,
        None,
        Some(&relative_path),
    )?;

    Ok(AssetImportResult {
        absolute_path: asset_path.to_string_lossy().to_string(),
        relative_path,
    })
}

fn read_document_content_and_version(path: &Path) -> Result<(String, DocumentVersion), String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let version = document_version_for_path_and_content(path, &content)?;
    Ok((content, version))
}

pub(crate) fn document_version_for_path_and_content(
    path: &Path,
    content: &str,
) -> Result<DocumentVersion, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());

    Ok(DocumentVersion {
        content_hash: file_service::content_hash(content),
        modified_ns,
        size: metadata.len(),
    })
}

fn sync_workspace_record(root_path: &Path, mdreview_path: &Path) -> Result<(), String> {
    let record_path = mdreview_path.join("workspace.json");
    let existing = file_service::read_optional_json::<WorkspaceRecord>(&record_path)?;
    let now = file_service::now_rfc3339()?;
    let created_at = existing
        .as_ref()
        .map(|record| record.created_at.clone())
        .unwrap_or_else(|| now.clone());

    let record = WorkspaceRecord {
        schema_version: 1,
        root_path: root_path.to_string_lossy().to_string(),
        created_at,
        updated_at: now,
    };

    file_service::write_json_atomic(&record_path, &record)
}

fn sanitize_asset_file_name(suggested_name: &str) -> String {
    let raw_file_name = Path::new(suggested_name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image.png")
        .trim();
    let candidate = if raw_file_name.is_empty() {
        "image.png"
    } else {
        raw_file_name
    };
    let sanitized: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches(|ch| matches!(ch, '.' | '-' | '_'));
    let path = Path::new(sanitized);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.trim_matches(|ch| matches!(ch, '.' | '-' | '_')))
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| is_supported_asset_extension(value))
        .unwrap_or_else(|| "png".into());

    format!("{stem}.{extension}")
}

fn is_supported_asset_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif")
}

fn next_available_asset_path(assets_dir: &Path, asset_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(asset_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid asset filename: {asset_name}"))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid asset filename: {asset_name}"))?;

    for index in 1..=10_000 {
        let file_name = if index == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let candidate = assets_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Could not choose a free asset filename for {asset_name}."
    ))
}

fn upsert_document_record(
    root_path: &Path,
    relative_path: &str,
    content: &str,
) -> Result<DocumentRecord, String> {
    let existing = read_document_record(root_path, &file_service::document_id(relative_path))?;
    if let Some(existing_record) = existing.as_ref() {
        let display_name = Path::new(relative_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(relative_path)
            .to_string();
        let current_content_hash = file_service::content_hash(content);
        let last_known_line_ending = file_service::line_ending(content);
        let frontmatter_mode = file_service::frontmatter_mode(content);
        let word_count = file_service::word_count(content);
        let heading_index = file_service::extract_heading_index(content);

        let is_unchanged = existing_record.relative_path == relative_path
            && existing_record.display_name == display_name
            && existing_record.current_content_hash == current_content_hash
            && existing_record.last_known_line_ending == last_known_line_ending
            && existing_record.frontmatter_mode == frontmatter_mode
            && existing_record.word_count == word_count
            && existing_record.heading_index == heading_index;

        if is_unchanged {
            return Ok(existing_record.clone());
        }
    }

    write_document_record(
        root_path,
        relative_path,
        content,
        existing
            .as_ref()
            .map(|record| record.created_at.clone())
            .as_deref(),
    )
}

fn summarize_document_without_content(
    relative_path: &str,
    document_path: &Path,
) -> Result<DocumentRecord, String> {
    let document_id = file_service::document_id(relative_path);
    let metadata = fs::metadata(document_path)
        .map_err(|error| format!("Unable to inspect {}: {error}", document_path.display()))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let now = file_service::now_rfc3339()?;
    let display_name = Path::new(relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(relative_path)
        .to_string();

    Ok(DocumentRecord {
        schema_version: 1,
        id: document_id,
        relative_path: relative_path.to_string(),
        display_name,
        created_at: now.clone(),
        updated_at: now,
        current_content_hash: format!("unindexed:{modified_ns}:{}", metadata.len()),
        last_known_line_ending: "lf".into(),
        frontmatter_mode: "none".into(),
        word_count: 0,
        heading_index: Vec::new(),
    })
}

fn write_document_record(
    root_path: &Path,
    relative_path: &str,
    content: &str,
    created_at: Option<&str>,
) -> Result<DocumentRecord, String> {
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let document_id = file_service::document_id(relative_path);
    let record_path = mdreview_path
        .join("documents")
        .join(format!("{document_id}.json"));
    let now = file_service::now_rfc3339()?;
    let display_name = Path::new(relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(relative_path)
        .to_string();
    let current_content_hash = file_service::content_hash(content);
    let last_known_line_ending = file_service::line_ending(content);
    let frontmatter_mode = file_service::frontmatter_mode(content);
    let word_count = file_service::word_count(content);
    let heading_index = file_service::extract_heading_index(content);
    let created_at = created_at.unwrap_or(&now).to_string();

    let record = DocumentRecord {
        schema_version: 1,
        id: document_id,
        relative_path: relative_path.to_string(),
        display_name,
        created_at,
        updated_at: now,
        current_content_hash,
        last_known_line_ending,
        frontmatter_mode,
        word_count,
        heading_index,
    };

    file_service::write_json_atomic(&record_path, &record)?;
    Ok(record)
}

fn read_document_record(
    root_path: &Path,
    document_id: &str,
) -> Result<Option<DocumentRecord>, String> {
    file_service::read_document_record_by_id(root_path, document_id)
}

fn remove_document_record(root_path: &Path, document_id: &str) -> Result<(), String> {
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    remove_file_if_exists(
        &mdreview_path
            .join("documents")
            .join(format!("{document_id}.json")),
    )
}

fn rename_document_file(
    from_path: &Path,
    to_path: &Path,
    to_relative_path: &str,
) -> Result<(), String> {
    let target_parent = to_path
        .parent()
        .ok_or_else(|| format!("Unable to derive a parent directory for {to_relative_path}."))?;
    fs::create_dir_all(target_parent)
        .map_err(|error| format!("Unable to create {}: {error}", target_parent.display()))?;

    if to_path.exists() {
        let same_file = from_path
            .canonicalize()
            .ok()
            .zip(to_path.canonicalize().ok())
            .map(|(from, to)| from == to)
            .unwrap_or(false);

        if !same_file {
            return Err(format!("{to_relative_path} already exists."));
        }

        let temporary_path = from_path.with_extension(format!(
            "margent-rename-{}.tmp",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| format!("Unable to compute system time: {error}"))?
                .as_nanos()
        ));
        fs::rename(from_path, &temporary_path).map_err(|error| {
            format!(
                "Unable to prepare case-only rename from {}: {error}",
                from_path.display()
            )
        })?;
        fs::rename(&temporary_path, to_path).map_err(|error| {
            format!(
                "Unable to rename {} to {}: {error}",
                temporary_path.display(),
                to_path.display()
            )
        })?;
        return Ok(());
    }

    fs::rename(from_path, to_path).map_err(|error| {
        format!(
            "Unable to rename {} to {}: {error}",
            from_path.display(),
            to_path.display()
        )
    })
}

fn retarget_document_sidecars(root_path: &Path, from_id: &str, to_id: &str) -> Result<(), String> {
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let now = file_service::now_rfc3339()?;

    retarget_thread_records(
        root_path,
        &mdreview_path.join("threads"),
        from_id,
        to_id,
        &now,
    )?;
    retarget_proposal_records(&mdreview_path.join("proposals"), from_id, to_id, &now)
}

fn retarget_thread_records(
    root_path: &Path,
    threads_dir: &Path,
    from_id: &str,
    to_id: &str,
    now: &str,
) -> Result<(), String> {
    for path in json_files_in_directory(threads_dir)? {
        let Some(mut thread) = file_service::read_scanned_json::<ThreadRecord>(&path, "thread")?
        else {
            continue;
        };

        if thread.document_id != from_id {
            continue;
        }

        thread.document_id = to_id.to_string();
        thread.updated_at = now.to_string();
        thread_service::save_thread_record(root_path, &thread)?;
    }

    Ok(())
}

fn retarget_proposal_records(
    proposals_dir: &Path,
    from_id: &str,
    to_id: &str,
    now: &str,
) -> Result<(), String> {
    for path in json_files_in_directory(proposals_dir)? {
        let Some(mut proposal) =
            file_service::read_scanned_json::<ProposalRecord>(&path, "proposal")?
        else {
            continue;
        };

        if proposal.document_id != from_id {
            continue;
        }

        proposal.document_id = to_id.to_string();
        proposal.updated_at = now.to_string();
        file_service::write_json_atomic(&path, &proposal)?;
    }

    Ok(())
}

fn remove_document_sidecars(root_path: &Path, document_id: &str) -> Result<(), String> {
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;

    for path in json_files_in_directory(&mdreview_path.join("threads"))? {
        let Some(thread) = file_service::read_scanned_json::<ThreadRecord>(&path, "thread")? else {
            continue;
        };

        if thread.document_id == document_id {
            remove_file_if_exists(&path)?;
        }
    }

    for path in json_files_in_directory(&mdreview_path.join("proposals"))? {
        let Some(proposal) = file_service::read_scanned_json::<ProposalRecord>(&path, "proposal")?
        else {
            continue;
        };

        if proposal.document_id == document_id {
            remove_file_if_exists(&path)?;
        }
    }

    Ok(())
}

fn json_files_in_directory(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();

    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Unable to read {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect sidecar records: {error}"))?;
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

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::models::document::HeadingIndexEntry;
    use crate::models::proposal::ProposalRecord;
    use crate::models::thread::AnchorRecord;

    use super::*;

    #[test]
    fn create_markdown_file_validates_workspace_relative_markdown_paths() {
        let workspace_root = unique_temp_dir("margent-create-file-validation");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let created = create_markdown_file(
            workspace_root.to_str().expect("root str"),
            "drafts/new-note.md",
            Some("# New Note\n"),
        )
        .expect("create markdown file");

        assert_eq!(created.relative_path, "drafts/new-note.md");
        assert!(workspace_root.join("drafts/new-note.md").is_file());

        let escape_error = create_markdown_file(
            workspace_root.to_str().expect("root str"),
            "../escape.md",
            None,
        )
        .expect_err("reject path traversal");
        assert!(escape_error.contains(".."));

        let extension_error = create_markdown_file(
            workspace_root.to_str().expect("root str"),
            "notes/plain.txt",
            None,
        )
        .expect_err("reject non-markdown extension");
        assert!(extension_error.contains(".md"));

        let reserved_error = create_markdown_file(
            workspace_root.to_str().expect("root str"),
            ".mdreview/hidden.md",
            None,
        )
        .expect_err("reject reserved sidecar directory");
        assert!(reserved_error.contains("reserved"));

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn open_workspace_summarizes_unselected_documents_without_reading_or_persisting() {
        let workspace_root = unique_temp_dir("margent-lazy-open-directory");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        fs::write(workspace_root.join("a-good.md"), "# Good\n\nAlpha beta\n").expect("write good");
        fs::write(workspace_root.join("z-bad.md"), [0xff, 0xfe, 0xfd]).expect("write invalid utf8");

        let workspace =
            open_workspace(workspace_root.to_str().expect("root str")).expect("open workspace");

        assert_eq!(workspace.documents.len(), 2);
        assert_eq!(
            workspace.selected_relative_path.as_deref(),
            Some("a-good.md")
        );
        let bad = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "z-bad.md")
            .expect("bad document summary");
        assert!(bad.current_content_hash.starts_with("unindexed:"));
        assert_eq!(bad.word_count, 0);
        assert!(bad.heading_index.is_empty());

        let document_sidecars =
            json_files_in_directory(&workspace_root.join(".mdreview").join("documents"))
                .expect("document sidecars");
        assert_eq!(document_sidecars.len(), 1);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn open_workspace_hydrates_only_the_opened_document() {
        let workspace_root = unique_temp_dir("margent-lazy-open-file");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        let opened_path = workspace_root.join("open.md");
        fs::write(&opened_path, "# Open\n\nAlpha beta\n").expect("write opened");
        fs::write(
            workspace_root.join("closed.md"),
            "# Closed\n\nGamma delta\n",
        )
        .expect("write closed");

        let workspace =
            open_workspace(opened_path.to_str().expect("opened path")).expect("open workspace");

        assert_eq!(workspace.selected_relative_path.as_deref(), Some("open.md"));
        let opened = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "open.md")
            .expect("opened document");
        assert!(opened.current_content_hash.starts_with("sha256:"));
        assert_eq!(opened.word_count, 4);
        assert_eq!(opened.heading_index.len(), 1);

        let closed = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "closed.md")
            .expect("closed document");
        assert!(closed.current_content_hash.starts_with("unindexed:"));
        assert_eq!(closed.word_count, 0);

        let document_sidecars =
            json_files_in_directory(&workspace_root.join(".mdreview").join("documents"))
                .expect("document sidecars");
        assert_eq!(document_sidecars.len(), 1);
        let expected_sidecar_name = format!("{}.json", opened.id);
        assert_eq!(
            document_sidecars[0]
                .file_name()
                .and_then(|value| value.to_str()),
            Some(expected_sidecar_name.as_str())
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn open_workspace_does_not_read_unselected_document_sidecars() {
        let workspace_root = unique_temp_dir("margent-lazy-open-stale-sidecar");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        let opened_path = workspace_root.join("open.md");
        fs::write(&opened_path, "# Open\n\nAlpha beta\n").expect("write opened");
        fs::write(
            workspace_root.join("closed.md"),
            "# Closed\n\nGamma delta\n",
        )
        .expect("write closed");
        let stale_closed_record = DocumentRecord {
            schema_version: 1,
            id: file_service::document_id("closed.md"),
            relative_path: "closed.md".into(),
            display_name: "closed.md".into(),
            created_at: "2026-06-11T00:00:00Z".into(),
            updated_at: "2026-06-11T00:00:00Z".into(),
            current_content_hash: "sha256:stale-sidecar".into(),
            last_known_line_ending: "lf".into(),
            frontmatter_mode: "none".into(),
            word_count: 99,
            heading_index: vec![HeadingIndexEntry {
                depth: 1,
                line: 1,
                text: "Stale".into(),
            }],
        };
        let mdreview = file_service::ensure_workspace_layout(&workspace_root).expect("layout");
        file_service::write_json_atomic(
            &mdreview
                .join("documents")
                .join(format!("{}.json", stale_closed_record.id)),
            &stale_closed_record,
        )
        .expect("write stale sidecar");

        let workspace =
            open_workspace(opened_path.to_str().expect("opened path")).expect("open workspace");

        let closed = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "closed.md")
            .expect("closed document");
        assert!(closed.current_content_hash.starts_with("unindexed:"));
        assert_eq!(closed.word_count, 0);
        assert!(closed.heading_index.is_empty());

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn rename_markdown_file_preserves_threads_and_proposals() {
        let workspace_root = unique_temp_dir("margent-rename-file");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        fs::write(workspace_root.join("draft.md"), "Alpha beta\n").expect("write document");

        let workspace =
            open_workspace(workspace_root.to_str().expect("root str")).expect("open workspace");
        let original_document = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "draft.md")
            .expect("document")
            .clone();

        let thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &original_document.id,
            "beta",
            "Review beta.",
            text_anchor("beta", "Alpha beta\n"),
        )
        .expect("create thread");
        let proposal = proposal_record("proposal_rename", &original_document.id, &thread.id);
        let mdreview = file_service::ensure_workspace_layout(&workspace_root).expect("layout");
        file_service::write_json_atomic(
            &mdreview.join("proposals").join("proposal_rename.json"),
            &proposal,
        )
        .expect("write proposal");

        let renamed = rename_markdown_file(
            workspace_root.to_str().expect("root str"),
            "draft.md",
            "notes/renamed.md",
        )
        .expect("rename document");

        assert_eq!(renamed.relative_path, "notes/renamed.md");
        assert_ne!(renamed.id, original_document.id);
        assert!(!workspace_root.join("draft.md").exists());
        assert!(workspace_root.join("notes/renamed.md").is_file());

        let migrated_threads =
            thread_service::load_threads(workspace_root.to_str().expect("root str"), &renamed.id)
                .expect("load migrated threads");
        assert_eq!(migrated_threads.len(), 1);
        assert_eq!(migrated_threads[0].id, thread.id);
        assert_eq!(migrated_threads[0].document_id, renamed.id);

        let migrated_proposal = file_service::read_optional_json::<ProposalRecord>(
            &mdreview.join("proposals").join("proposal_rename.json"),
        )
        .expect("read migrated proposal")
        .expect("migrated proposal exists");
        assert_eq!(migrated_proposal.document_id, renamed.id);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn delete_markdown_file_removes_document_threads_and_proposals() {
        let workspace_root = unique_temp_dir("margent-delete-file");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        fs::write(workspace_root.join("delete-me.md"), "Alpha beta\n").expect("write document");
        fs::write(workspace_root.join("keep.md"), "Keep me\n").expect("write keeper");

        let workspace =
            open_workspace(workspace_root.to_str().expect("root str")).expect("open workspace");
        let deleted_document = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "delete-me.md")
            .expect("delete document")
            .clone();
        let kept_document = workspace
            .documents
            .iter()
            .find(|document| document.relative_path == "keep.md")
            .expect("keep document")
            .clone();
        let thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &deleted_document.id,
            "beta",
            "Review beta.",
            text_anchor("beta", "Alpha beta\n"),
        )
        .expect("create deleted document thread");
        let kept_thread = thread_service::create_thread(
            workspace_root.to_str().expect("root str"),
            &kept_document.id,
            "Keep",
            "Keep this.",
            text_anchor("Keep", "Keep me\n"),
        )
        .expect("create kept document thread");
        let mdreview = file_service::ensure_workspace_layout(&workspace_root).expect("layout");
        file_service::write_json_atomic(
            &mdreview.join("proposals").join("proposal_delete.json"),
            &proposal_record("proposal_delete", &deleted_document.id, &thread.id),
        )
        .expect("write deleted proposal");

        let refreshed =
            delete_markdown_file(workspace_root.to_str().expect("root str"), "delete-me.md")
                .expect("delete document");

        assert!(!workspace_root.join("delete-me.md").exists());
        assert_eq!(refreshed.documents.len(), 1);
        assert_eq!(refreshed.documents[0].relative_path, "keep.md");
        assert!(!mdreview
            .join("documents")
            .join(format!("{}.json", deleted_document.id))
            .exists());
        assert!(!mdreview
            .join("threads")
            .join(format!("{}.json", thread.id))
            .exists());
        assert!(mdreview
            .join("threads")
            .join(format!("{}.json", kept_thread.id))
            .exists());
        assert!(!mdreview
            .join("proposals")
            .join("proposal_delete.json")
            .exists());
        let snapshots_dir = mdreview.join("snapshots");
        let snapshot_paths = fs::read_dir(&snapshots_dir)
            .expect("read snapshots")
            .map(|entry| entry.expect("snapshot entry").path())
            .collect::<Vec<_>>();
        assert_eq!(snapshot_paths.len(), 1);
        let snapshot = file_service::read_optional_json::<
            crate::models::snapshot::DocumentSnapshotRecord,
        >(&snapshot_paths[0])
        .expect("read snapshot")
        .expect("snapshot exists");
        assert_eq!(snapshot.relative_path, "delete-me.md");
        assert_eq!(snapshot.content, "Alpha beta\n");
        assert_eq!(snapshot.reason, "delete");

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn list_document_snapshots_filters_by_normalized_relative_path() {
        let workspace_root = unique_temp_dir("margent-list-snapshots");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        let draft_content = "Draft snapshot\n";
        let notes_content = "Notes snapshot\n";
        fs::write(workspace_root.join("draft.md"), draft_content).expect("write draft");
        fs::create_dir_all(workspace_root.join("notes")).expect("create notes");
        fs::write(workspace_root.join("notes/other.md"), notes_content).expect("write other");
        let draft = upsert_document_record(&workspace_root, "draft.md", draft_content)
            .expect("index draft");
        let other = upsert_document_record(&workspace_root, "notes/other.md", notes_content)
            .expect("index other");

        snapshot_document(&workspace_root, &draft, draft_content, "test", None)
            .expect("snapshot draft");
        snapshot_document(&workspace_root, &other, notes_content, "test", None)
            .expect("snapshot other");

        let all = list_document_snapshots(workspace_root.to_str().expect("root str"), None)
            .expect("list all snapshots");
        assert_eq!(all.len(), 2);

        let filtered = list_document_snapshots(
            workspace_root.to_str().expect("root str"),
            Some("./notes/other.md"),
        )
        .expect("list filtered snapshots");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].relative_path, "notes/other.md");
        assert_eq!(filtered[0].content, notes_content);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn revert_latest_snapshot_restores_document_content_and_record() {
        let workspace_root = unique_temp_dir("margent-tauri-revert-snapshot");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        let original = "# Draft\n\nOriginal body.\n";
        let changed = "# Draft\n\nChanged body.\n";
        fs::write(workspace_root.join("draft.md"), original).expect("write original");
        let document =
            upsert_document_record(&workspace_root, "draft.md", original).expect("index original");
        let snapshot = snapshot_document(
            &workspace_root,
            &document,
            original,
            "proposal.accept",
            Some("proposal_test"),
        )
        .expect("snapshot original");
        fs::write(workspace_root.join("draft.md"), changed).expect("write changed");
        upsert_document_record(&workspace_root, "draft.md", changed).expect("index changed");

        let result =
            revert_latest_snapshot(workspace_root.to_str().expect("root str"), Some("draft.md"))
                .expect("revert latest snapshot");

        assert_eq!(result.snapshot.id, snapshot.id);
        assert_eq!(result.document.relative_path, "draft.md");
        assert_eq!(result.document.content, original);
        assert_eq!(
            result.document.current_content_hash,
            file_service::content_hash(original)
        );
        assert_eq!(
            fs::read_to_string(workspace_root.join("draft.md")).expect("read restored"),
            original
        );
        let restored_record =
            file_service::read_document_record_by_id(&workspace_root, &document.id)
                .expect("read document sidecar")
                .expect("document sidecar");
        assert_eq!(
            restored_record.current_content_hash,
            file_service::content_hash(original)
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn save_document_if_current_saves_when_expected_version_matches() {
        let workspace_root = unique_temp_dir("margent-save-current");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        fs::write(workspace_root.join("draft.md"), "Alpha beta\n").expect("write document");

        let loaded =
            read_document(workspace_root.to_str().expect("root str"), "draft.md").expect("read");
        let next_content = "Alpha beta gamma\n";

        let result = save_document_if_current(
            workspace_root.to_str().expect("root str"),
            "draft.md",
            next_content,
            &loaded.version,
            "op-save-1",
        )
        .expect("save if current");

        let SaveDocumentIfCurrentResult::Saved {
            document,
            operation_id,
        } = result
        else {
            panic!("expected saved result");
        };

        assert_eq!(operation_id, "op-save-1");
        assert_eq!(document.relative_path, "draft.md");
        assert_eq!(document.content, next_content);
        assert_eq!(
            document.current_content_hash,
            file_service::content_hash(next_content)
        );
        assert_eq!(
            document.version.content_hash,
            file_service::content_hash(next_content)
        );
        assert_eq!(document.version.size, next_content.len() as u64);
        assert_eq!(
            fs::read_to_string(workspace_root.join("draft.md")).expect("read saved"),
            next_content
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn save_document_if_current_conflicts_without_overwriting_external_change() {
        let workspace_root = unique_temp_dir("margent-save-conflict");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        fs::write(workspace_root.join("draft.md"), "Alpha beta\n").expect("write document");

        let loaded =
            read_document(workspace_root.to_str().expect("root str"), "draft.md").expect("read");
        let external_content = "External change\n";
        fs::write(workspace_root.join("draft.md"), external_content).expect("write external");

        let result = save_document_if_current(
            workspace_root.to_str().expect("root str"),
            "draft.md",
            "Unsaved local buffer\n",
            &loaded.version,
            "op-conflict-1",
        )
        .expect("save if current conflict");

        let SaveDocumentIfCurrentResult::Conflict {
            expected_version,
            actual_version,
            operation_id,
        } = result
        else {
            panic!("expected conflict result");
        };

        assert_eq!(operation_id, "op-conflict-1");
        assert_eq!(expected_version, loaded.version);
        assert_eq!(
            actual_version.content_hash,
            file_service::content_hash(external_content)
        );
        assert_eq!(actual_version.size, external_content.len() as u64);
        assert_eq!(
            fs::read_to_string(workspace_root.join("draft.md")).expect("read conflicted"),
            external_content
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn import_asset_sanitizes_and_deduplicates_file_names() {
        let workspace_root = unique_temp_dir("margent-import-asset");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let first = import_asset(
            workspace_root.to_str().expect("root str"),
            "../Sketch File.PNG",
            vec![1, 2, 3],
        )
        .expect("import first asset");
        let second = import_asset(
            workspace_root.to_str().expect("root str"),
            "../Sketch File.PNG",
            vec![4, 5, 6],
        )
        .expect("import second asset");

        assert_eq!(first.relative_path, "assets/Sketch-File.png");
        assert_eq!(second.relative_path, "assets/Sketch-File-2.png");
        assert_eq!(
            fs::read(workspace_root.join(&first.relative_path)).expect("read first"),
            vec![1, 2, 3]
        );
        assert_eq!(
            fs::read(workspace_root.join(&second.relative_path)).expect("read second"),
            vec![4, 5, 6]
        );

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    #[test]
    fn snapshot_document_prunes_old_document_snapshots() {
        let workspace_root = unique_temp_dir("margent-snapshot-retention");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");
        fs::write(workspace_root.join("draft.md"), "Alpha beta\n").expect("write document");
        let workspace =
            open_workspace(workspace_root.to_str().expect("root str")).expect("open workspace");
        let document = workspace.documents.first().expect("document");

        for index in 0..(MAX_SNAPSHOTS_PER_DOCUMENT + 5) {
            snapshot_document(
                &workspace_root,
                document,
                &format!("Snapshot {index}\n"),
                "test",
                None,
            )
            .expect("snapshot document");
        }

        let snapshots_dir = workspace_root.join(".mdreview").join("snapshots");
        let snapshot_count = fs::read_dir(&snapshots_dir)
            .expect("read snapshots")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .count();
        assert_eq!(snapshot_count, MAX_SNAPSHOTS_PER_DOCUMENT);

        fs::remove_dir_all(&workspace_root).expect("cleanup temp workspace");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nonce}"))
    }

    fn text_anchor(quote: &str, content: &str) -> AnchorRecord {
        let start = content.find(quote).expect("quote exists");
        AnchorRecord {
            quote: quote.into(),
            prefix_context: content[..start].into(),
            suffix_context: content[start + quote.len()..].into(),
            start_offset_utf16: start,
            end_offset_utf16: start + quote.len(),
            start_line: 1,
            start_column: start + 1,
            end_line: 1,
            end_column: start + quote.len() + 1,
            heading_path: Vec::new(),
            block_fingerprint: "sha256:test-block".into(),
            base_content_hash: file_service::content_hash(content),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        }
    }

    fn proposal_record(id: &str, document_id: &str, thread_id: &str) -> ProposalRecord {
        ProposalRecord {
            schema_version: 1,
            id: id.into(),
            document_id: document_id.into(),
            thread_ids: vec![thread_id.into()],
            adapter_id: "test-adapter".into(),
            created_at: "2026-06-11T00:00:00Z".into(),
            updated_at: "2026-06-11T00:00:00Z".into(),
            status: "pending".into(),
            base_content_hash: "sha256:base".into(),
            response_mode: "updated_document".into(),
            summary: "Test proposal".into(),
            assistant_message: "Test assistant message".into(),
            updated_document_text: Some("Updated text\n".into()),
            unified_diff: None,
            computed_diff: String::new(),
            warnings: Vec::new(),
            resolve_thread_ids: Vec::new(),
            stderr: None,
            error_message: None,
            extra: Default::default(),
        }
    }
}
