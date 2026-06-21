use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::id::new_id;

const MAX_TEMP_FILE_ATTEMPTS: usize = 64;

pub fn write_string_atomic(path: &Path, body: &str) -> Result<(), String> {
    write_file_atomic(path, body.as_bytes())
}

pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid filename for {}", path.display()))?;
    let (mut file, tmp_path) = create_temp_file(parent, file_name)?;

    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Unable to write {}: {error}", tmp_path.display()));
    }
    drop(file);

    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "Unable to move {} into place at {}: {error}",
            tmp_path.display(),
            path.display()
        ));
    }

    sync_parent_dir_best_effort(parent);
    Ok(())
}

fn create_temp_file(parent: &Path, file_name: &std::ffi::OsStr) -> Result<(File, PathBuf), String> {
    let mut last_error = None;

    for _ in 0..MAX_TEMP_FILE_ATTEMPTS {
        let tmp_path = parent.join(temp_file_name(file_name));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(file) => return Ok((file, tmp_path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => {
                return Err(format!(
                    "Unable to create temporary file {}: {error}",
                    tmp_path.display()
                ));
            }
        }
    }

    Err(format!(
        "Unable to create a unique temporary file in {} after {MAX_TEMP_FILE_ATTEMPTS} attempts: {}",
        parent.display(),
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no attempts were made".to_string())
    ))
}

fn temp_file_name(file_name: &std::ffi::OsStr) -> OsString {
    let mut tmp_name = OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(".");
    tmp_name.push(new_id("write"));
    tmp_name.push(".tmp");
    tmp_name
}

#[cfg(unix)]
fn sync_parent_dir_best_effort(parent: &Path) {
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
}

#[cfg(not(unix))]
fn sync_parent_dir_best_effort(_parent: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(new_id(name));
        fs::create_dir_all(&root).expect("create temp test directory");
        root
    }

    #[test]
    fn atomic_write_creates_new_file_and_parent_directories() {
        let root = temp_root("margent_core_io_create_test");
        let path = root.join("nested").join("review.json");

        write_string_atomic(&path, "{\"ok\":true}").expect("write file");

        assert_eq!(
            fs::read_to_string(&path).expect("read written file"),
            "{\"ok\":true}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let root = temp_root("margent_core_io_replace_test");
        let path = root.join("review.json");
        fs::write(&path, "old").expect("seed existing file");

        write_file_atomic(&path, b"new").expect("replace existing file");

        assert_eq!(
            fs::read_to_string(&path).expect("read replaced file"),
            "new"
        );

        let _ = fs::remove_dir_all(root);
    }
}
