use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use walkdir::WalkDir;

use crate::models::document::HeadingIndexEntry;

const EXCLUDED_WORKSPACE_DIRS: [&str; 5] = [".mdreview", ".git", "node_modules", "target", "dist"];

pub fn ensure_workspace_layout(root: &Path) -> Result<PathBuf, String> {
    let mdreview_path = root.join(".mdreview");

    fs::create_dir_all(mdreview_path.join("documents"))
        .map_err(|error| format!("Unable to create .mdreview/documents: {error}"))?;
    fs::create_dir_all(mdreview_path.join("threads"))
        .map_err(|error| format!("Unable to create .mdreview/threads: {error}"))?;
    fs::create_dir_all(mdreview_path.join("proposals"))
        .map_err(|error| format!("Unable to create .mdreview/proposals: {error}"))?;
    fs::create_dir_all(mdreview_path.join("agents"))
        .map_err(|error| format!("Unable to create .mdreview/agents: {error}"))?;
    fs::create_dir_all(mdreview_path.join("authorship"))
        .map_err(|error| format!("Unable to create .mdreview/authorship: {error}"))?;
    fs::create_dir_all(mdreview_path.join("snapshots"))
        .map_err(|error| format!("Unable to create .mdreview/snapshots: {error}"))?;

    let adapters_path = mdreview_path.join("adapters.json");
    if !adapters_path.exists() {
        write_string_atomic(&adapters_path, "[]\n")?;
    }

    let events_path = mdreview_path.join("events.ndjson");
    if !events_path.exists() {
        write_string_atomic(&events_path, "")?;
    }

    Ok(mdreview_path)
}

pub fn read_optional_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let text = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;

    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("Unable to parse {}: {error}", path.display()))
}

pub fn read_scanned_json<T: DeserializeOwned>(
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

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Unable to serialize {}: {error}", path.display()))?;
    write_string_atomic(path, &format!("{body}\n"))
}

pub fn write_string_atomic(path: &Path, body: &str) -> Result<(), String> {
    margent_core::io::write_string_atomic(path, body)
}

pub fn write_bytes_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    margent_core::io::write_file_atomic(path, body)
}

pub fn append_ndjson<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Missing parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;

    let body = serde_json::to_string(value)
        .map_err(|error| format!("Unable to serialize {}: {error}", path.display()))?;
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|error| format!("Unable to open {}: {error}", path.display()))?;

    writeln!(file, "{body}")
        .map_err(|error| format!("Unable to append {}: {error}", path.display()))?;
    file.flush()
        .map_err(|error| format!("Unable to flush {}: {error}", path.display()))?;
    file.sync_data()
        .map_err(|error| format!("Unable to sync {}: {error}", path.display()))
}

pub fn list_markdown_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let walker = WalkDir::new(root).into_iter().filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }

        if entry.file_type().is_dir() {
            let name = entry.file_name().to_string_lossy();
            return !is_excluded_workspace_dir_name(name.as_ref());
        }

        true
    });

    for entry in walker {
        let entry = entry.map_err(|error| format!("Unable to walk workspace: {error}"))?;
        if !entry.file_type().is_file() {
            continue;
        }

        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());

        if matches!(extension.as_deref(), Some("md" | "markdown")) {
            files.push(entry.into_path());
        }
    }

    files.sort();
    Ok(files)
}

pub fn resolve_workspace_root(path: &Path) -> Result<(PathBuf, Option<PathBuf>), String> {
    if !path.exists() {
        return Err(format!("{} does not exist.", path.display()));
    }

    if path.is_dir() {
        let selected_directory = path
            .canonicalize()
            .map_err(|error| format!("Unable to open {}: {error}", path.display()))?;
        let root = find_existing_workspace_root(&selected_directory)
            .unwrap_or_else(|| selected_directory.clone());
        return Ok((root, None));
    }

    let opened_path = path
        .canonicalize()
        .map_err(|error| format!("Unable to open {}: {error}", path.display()))?;
    let parent = opened_path
        .parent()
        .ok_or_else(|| format!("Unable to derive a workspace root from {}", path.display()))?
        .to_path_buf();
    let root = find_existing_workspace_root(&parent).unwrap_or(parent);

    Ok((root, Some(opened_path)))
}

fn is_excluded_workspace_dir_name(name: &str) -> bool {
    EXCLUDED_WORKSPACE_DIRS.contains(&name)
}

fn find_existing_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    let mut found = None;

    loop {
        if current.join(".mdreview").is_dir() {
            found = Some(current.clone());
        }

        if !current.pop() {
            return found;
        }
    }
}

pub fn resolve_document_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical_root = root.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace root {}: {error}",
            root.display()
        )
    })?;
    let candidate = canonical_root.join(relative_path);
    let parent = candidate.parent().ok_or_else(|| {
        format!(
            "Unable to derive the parent directory for {relative_path} inside {}",
            canonical_root.display()
        )
    })?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Unable to resolve {}: {error}", parent.display()))?;

    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Document path escapes the active workspace.".into());
    }

    let file_name = candidate
        .file_name()
        .ok_or_else(|| format!("Missing file name for {relative_path}"))?;

    Ok(canonical_parent.join(file_name))
}

pub fn resolve_new_document_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical_root = root.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace root {}: {error}",
            root.display()
        )
    })?;
    let normalized_relative_path = normalize_workspace_relative_path(relative_path)?;

    if !is_markdown_relative_path(&normalized_relative_path) {
        return Err("Markdown files must use a .md or .markdown extension.".into());
    }

    if normalized_relative_path
        .components()
        .any(|component| match component {
            Component::Normal(segment) => {
                is_excluded_workspace_dir_name(segment.to_string_lossy().as_ref())
            }
            _ => false,
        })
    {
        return Err("Document path uses a reserved workspace directory.".into());
    }

    Ok(canonical_root.join(normalized_relative_path))
}

fn normalize_workspace_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err("Document path cannot be empty.".into());
    }

    if trimmed.chars().any(char::is_control) {
        return Err("Document path contains invalid control characters.".into());
    }

    let path = Path::new(trimmed);
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            Component::CurDir => {}
            Component::ParentDir => return Err("Document path cannot contain '..'.".into()),
            Component::Prefix(_) | Component::RootDir => {
                return Err("Document path must stay inside the active workspace.".into())
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("Document path cannot be empty.".into());
    }

    Ok(normalized)
}

fn is_markdown_relative_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}

pub fn relative_path_string(root: &Path, file: &Path) -> Result<String, String> {
    file.strip_prefix(root)
        .map_err(|error| {
            format!(
                "Unable to compute a relative path for {} within {}: {error}",
                file.display(),
                root.display()
            )
        })
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

pub fn document_id(relative_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_path.as_bytes());
    format!("doc_{}", &hex::encode(hasher.finalize())[..16])
}

pub fn content_hash(content: &str) -> String {
    margent_core::document::content_hash(content)
}

pub fn line_ending(content: &str) -> String {
    if content.contains("\r\n") {
        "crlf".into()
    } else {
        "lf".into()
    }
}

pub fn frontmatter_mode(content: &str) -> String {
    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        "yaml".into()
    } else {
        "none".into()
    }
}

pub fn word_count(content: &str) -> usize {
    content.split_whitespace().count()
}

pub fn extract_heading_index(content: &str) -> Vec<HeadingIndexEntry> {
    margent_core::document::extract_heading_index(content)
}

pub fn now_rfc3339() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| format!("Unable to format the current timestamp: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{list_markdown_files, resolve_workspace_root};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("margent-{label}-{nonce}"))
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn list_markdown_files_includes_hidden_directories_but_skips_explicit_ignores() {
        let root = unique_temp_dir("file-service-scan");
        fs::create_dir_all(&root).expect("create temp root");

        write_file(&root.join("visible.md"), "# Visible\n");
        write_file(&root.join(".hidden/secret.md"), "# Secret\n");
        write_file(&root.join(".mdreview/ignored.md"), "# Ignore me\n");
        write_file(&root.join("node_modules/ignored.md"), "# Ignore me too\n");

        let files = list_markdown_files(&root).expect("scan workspace");
        let relative_paths: Vec<String> = files
            .iter()
            .map(|path| {
                path.strip_prefix(&root)
                    .expect("relative path")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();

        assert_eq!(relative_paths, vec![".hidden/secret.md", "visible.md"]);

        fs::remove_dir_all(&root).expect("remove temp root");
    }

    #[test]
    fn resolve_workspace_root_prefers_existing_mdreview_ancestor_for_opened_files() {
        let root = unique_temp_dir("file-service-root");
        let nested = root.join("drafts/chapter");
        let opened_file = nested.join("scene.md");
        fs::create_dir_all(root.join(".mdreview")).expect("create workspace marker");
        write_file(&opened_file, "# Scene\n");
        let canonical_root = root.canonicalize().expect("canonical root");
        let canonical_opened_file = opened_file.canonicalize().expect("canonical opened file");

        let (resolved_root, opened_path) = resolve_workspace_root(&opened_file).expect("resolve");

        assert_eq!(resolved_root, canonical_root);
        assert_eq!(opened_path.expect("opened path"), canonical_opened_file);

        fs::remove_dir_all(&root).expect("remove temp root");
    }

    #[test]
    fn resolve_workspace_root_prefers_outermost_mdreview_ancestor_for_opened_files() {
        let root = unique_temp_dir("file-service-outermost-root");
        let nested_workspace = root.join("drafts/chapter");
        let opened_file = nested_workspace.join("scene.md");
        fs::create_dir_all(root.join(".mdreview")).expect("create outer workspace marker");
        fs::create_dir_all(nested_workspace.join(".mdreview"))
            .expect("create nested workspace marker");
        write_file(&opened_file, "# Scene\n");
        let canonical_root = root.canonicalize().expect("canonical root");
        let canonical_opened_file = opened_file.canonicalize().expect("canonical opened file");

        let (resolved_root, opened_path) = resolve_workspace_root(&opened_file).expect("resolve");

        assert_eq!(resolved_root, canonical_root);
        assert_eq!(opened_path.expect("opened path"), canonical_opened_file);

        fs::remove_dir_all(&root).expect("remove temp root");
    }

    #[test]
    fn resolve_workspace_root_prefers_outermost_mdreview_ancestor_for_opened_directories() {
        let root = unique_temp_dir("file-service-directory-root");
        let nested_workspace = root.join("drafts/chapter");
        fs::create_dir_all(root.join(".mdreview")).expect("create outer workspace marker");
        fs::create_dir_all(nested_workspace.join(".mdreview"))
            .expect("create nested workspace marker");
        let canonical_root = root.canonicalize().expect("canonical root");

        let (resolved_root, opened_path) =
            resolve_workspace_root(&nested_workspace).expect("resolve");

        assert_eq!(resolved_root, canonical_root);
        assert!(opened_path.is_none());

        fs::remove_dir_all(&root).expect("remove temp root");
    }
}
