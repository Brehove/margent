use std::collections::HashSet;
use std::env;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use wait_timeout::ChildExt;

use crate::models::adapter::AdapterDefinition;

use super::file_service;

pub struct AdapterExecutionOutput {
    pub exit_code: i32,
    pub stderr: String,
    pub stdout: String,
    pub timed_out: bool,
}

pub fn load_adapters(workspace_root: &str) -> Result<Vec<AdapterDefinition>, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let adapters_path = mdreview_path.join("adapters.json");

    Ok(
        file_service::read_optional_json::<Vec<AdapterDefinition>>(&adapters_path)?
            .unwrap_or_default(),
    )
}

pub fn save_adapters(
    workspace_root: &str,
    adapters: Vec<AdapterDefinition>,
) -> Result<Vec<AdapterDefinition>, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let adapters_path = mdreview_path.join("adapters.json");
    let validated = validate_adapters(adapters)?;

    file_service::write_json_atomic(&adapters_path, &validated)?;
    Ok(validated)
}

pub fn find_adapter(
    workspace_root: &str,
    adapter_id: &str,
) -> Result<Option<AdapterDefinition>, String> {
    let adapters = load_adapters(workspace_root)?;
    Ok(adapters
        .into_iter()
        .find(|adapter| adapter.id == adapter_id))
}

pub fn execute_adapter(
    adapter: &AdapterDefinition,
    workspace_root: &Path,
    document_path: &Path,
    request_json: &str,
) -> Result<AdapterExecutionOutput, String> {
    if adapter.command.trim().is_empty() {
        return Err(format!(
            "Adapter {} does not have a command configured.",
            adapter.name
        ));
    }

    if adapter.input_mode != "stdin_json" {
        return Err(format!(
            "Adapter {} uses unsupported inputMode {}.",
            adapter.name, adapter.input_mode
        ));
    }

    if adapter.output_mode != "stdout_json" {
        return Err(format!(
            "Adapter {} uses unsupported outputMode {}.",
            adapter.name, adapter.output_mode
        ));
    }

    let mut command = Command::new(&adapter.command);
    command
        .args(&adapter.args)
        .current_dir(resolve_working_directory(
            &adapter.working_directory_mode,
            workspace_root,
            document_path,
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for key in &adapter.environment_allowlist {
        if let Ok(value) = env::var(key) {
            command.env(key, value);
        }
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Unable to start adapter {} with command {}: {error}",
            adapter.name, adapter.command
        )
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(request_json.as_bytes())
            .map_err(|error| format!("Unable to send request JSON to {}: {error}", adapter.name))?;
    }

    let timed_out = child
        .wait_timeout(Duration::from_secs(adapter.timeout_seconds.max(1)))
        .map_err(|error| format!("Unable to wait on adapter {}: {error}", adapter.name))?
        .is_none();

    if timed_out {
        child.kill().map_err(|error| {
            format!("Unable to stop timed out adapter {}: {error}", adapter.name)
        })?;
    }

    let output = child.wait_with_output().map_err(|error| {
        format!(
            "Unable to capture adapter output for {}: {error}",
            adapter.name
        )
    })?;

    Ok(AdapterExecutionOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        timed_out,
    })
}

fn resolve_working_directory(mode: &str, workspace_root: &Path, document_path: &Path) -> PathBuf {
    match mode {
        "document_parent" => document_path
            .parent()
            .map(|path| path.to_path_buf())
            .unwrap_or_else(|| workspace_root.to_path_buf()),
        _ => workspace_root.to_path_buf(),
    }
}

fn validate_adapters(adapters: Vec<AdapterDefinition>) -> Result<Vec<AdapterDefinition>, String> {
    let mut validated = Vec::with_capacity(adapters.len());
    let mut seen_ids = HashSet::new();

    for (index, mut adapter) in adapters.into_iter().enumerate() {
        adapter.id = adapter.id.trim().to_string();
        adapter.name = adapter.name.trim().to_string();
        adapter.command = adapter.command.trim().to_string();
        adapter.args = normalize_string_list(adapter.args);
        adapter.environment_allowlist = normalize_string_list(adapter.environment_allowlist);
        adapter.capabilities = normalize_string_list(adapter.capabilities);

        if adapter.id.is_empty() {
            return Err(format!("Adapter {} is missing an id.", index + 1));
        }

        if adapter.name.is_empty() {
            return Err(format!("Adapter {} is missing a name.", adapter.id));
        }

        if adapter.command.is_empty() {
            return Err(format!("Adapter {} is missing a command.", adapter.id));
        }

        if !seen_ids.insert(adapter.id.clone()) {
            return Err(format!("Adapter id {} is duplicated.", adapter.id));
        }

        if !matches!(
            adapter.working_directory_mode.as_str(),
            "workspace_root" | "document_parent"
        ) {
            return Err(format!(
                "Adapter {} uses unsupported workingDirectoryMode {}.",
                adapter.id, adapter.working_directory_mode
            ));
        }

        if adapter.input_mode != "stdin_json" {
            return Err(format!(
                "Adapter {} uses unsupported inputMode {}.",
                adapter.id, adapter.input_mode
            ));
        }

        if adapter.output_mode != "stdout_json" {
            return Err(format!(
                "Adapter {} uses unsupported outputMode {}.",
                adapter.id, adapter.output_mode
            ));
        }

        if adapter.timeout_seconds == 0 {
            return Err(format!(
                "Adapter {} must have a timeout greater than zero.",
                adapter.id
            ));
        }

        if !adapter
            .capabilities
            .iter()
            .any(|capability| capability == "propose_revision")
        {
            return Err(format!(
                "Adapter {} must include the propose_revision capability.",
                adapter.id
            ));
        }

        validated.push(adapter);
    }

    Ok(validated)
}

fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn save_adapters_persists_validated_records() {
        let workspace_root = unique_temp_dir("margent-adapter-save-test");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let saved = save_adapters(
            workspace_root.to_str().expect("root str"),
            vec![AdapterDefinition {
                id: " generic ".into(),
                name: " Generic Adapter ".into(),
                command: " /usr/bin/env ".into(),
                args: vec![" python3 ".into(), "".into()],
                working_directory_mode: "workspace_root".into(),
                environment_allowlist: vec![" OPENAI_API_KEY ".into(), " ".into()],
                input_mode: "stdin_json".into(),
                output_mode: "stdout_json".into(),
                capabilities: vec![" propose_revision ".into()],
                timeout_seconds: 30,
            }],
        )
        .expect("save adapters");

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, "generic");
        assert_eq!(saved[0].args, vec!["python3"]);
        assert_eq!(saved[0].environment_allowlist, vec!["OPENAI_API_KEY"]);

        let loaded =
            load_adapters(workspace_root.to_str().expect("root str")).expect("load adapters");
        assert_eq!(loaded, saved);

        fs::remove_dir_all(&workspace_root).expect("cleanup");
    }

    #[test]
    fn save_adapters_rejects_duplicate_ids() {
        let workspace_root = unique_temp_dir("margent-adapter-duplicate-test");
        fs::create_dir_all(&workspace_root).expect("create temp workspace");

        let error = save_adapters(
            workspace_root.to_str().expect("root str"),
            vec![
                AdapterDefinition {
                    id: "duplicate".into(),
                    name: "One".into(),
                    command: "cmd".into(),
                    args: Vec::new(),
                    working_directory_mode: "workspace_root".into(),
                    environment_allowlist: Vec::new(),
                    input_mode: "stdin_json".into(),
                    output_mode: "stdout_json".into(),
                    capabilities: vec!["propose_revision".into()],
                    timeout_seconds: 10,
                },
                AdapterDefinition {
                    id: "duplicate".into(),
                    name: "Two".into(),
                    command: "cmd".into(),
                    args: Vec::new(),
                    working_directory_mode: "workspace_root".into(),
                    environment_allowlist: Vec::new(),
                    input_mode: "stdin_json".into(),
                    output_mode: "stdout_json".into(),
                    capabilities: vec!["propose_revision".into()],
                    timeout_seconds: 10,
                },
            ],
        )
        .expect_err("duplicate ids should fail");

        assert!(error.contains("duplicated"));

        fs::remove_dir_all(&workspace_root).expect("cleanup");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nonce}"))
    }
}
