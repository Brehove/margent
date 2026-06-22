use std::fs;
use std::path::Path;

use crate::models::agent::AgentCursorRecord;

use super::file_service;

#[allow(dead_code)]
pub fn load_agent_cursor(
    workspace_root: &str,
    agent_id: &str,
) -> Result<Option<AgentCursorRecord>, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let agent_path = mdreview_path
        .join("agents")
        .join(format!("{agent_id}.json"));

    file_service::read_optional_json::<AgentCursorRecord>(&agent_path)
}

#[allow(dead_code)]
pub fn save_agent_cursor(workspace_root: &str, cursor: &AgentCursorRecord) -> Result<(), String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let agent_path = mdreview_path
        .join("agents")
        .join(format!("{}.json", cursor.agent_id));

    file_service::write_json_atomic(&agent_path, cursor)
}

#[allow(dead_code)]
pub fn list_agent_cursors(workspace_root: &str) -> Result<Vec<AgentCursorRecord>, String> {
    let root_path = Path::new(workspace_root);
    let mdreview_path = file_service::ensure_workspace_layout(root_path)?;
    let agents_dir = mdreview_path.join("agents");
    let mut cursors = Vec::new();

    for entry in fs::read_dir(&agents_dir)
        .map_err(|error| format!("Unable to read {}: {error}", agents_dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect agent records: {error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if let Some(cursor) =
            file_service::read_scanned_json::<AgentCursorRecord>(&path, "agent cursor")?
        {
            cursors.push(cursor);
        }
    }

    Ok(cursors)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::models::agent::AgentCursorRecord;

    use super::{file_service, list_agent_cursors, load_agent_cursor, save_agent_cursor};

    #[test]
    fn list_agent_cursors_skips_corrupt_sibling_sidecar() {
        let workspace_root = unique_temp_dir("margent-agent-cursor-corrupt-sibling");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let cursor = AgentCursorRecord {
            agent_id: "codex".into(),
            provider_id: Some("codex".into()),
            adapter_id: None,
            last_seen_event_id: Some("evt_1".into()),
            last_synced_at: Some("2026-06-21T00:00:00Z".into()),
            last_sync_status: Some("ok".into()),
            notes: None,
        };
        save_agent_cursor(workspace_root.to_str().expect("root str"), &cursor)
            .expect("save cursor");
        let mdreview_path =
            file_service::ensure_workspace_layout(&workspace_root).expect("ensure layout");
        fs::write(
            mdreview_path.join("agents").join("broken.json"),
            "{not json",
        )
        .expect("write corrupt cursor");

        let cursors =
            list_agent_cursors(workspace_root.to_str().expect("root str")).expect("list cursors");

        assert_eq!(cursors, vec![cursor]);
        fs::remove_dir_all(&workspace_root).expect("cleanup workspace");
    }

    #[test]
    fn load_agent_cursor_keeps_direct_read_strict() {
        let workspace_root = unique_temp_dir("margent-agent-cursor-strict-read");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let mdreview_path =
            file_service::ensure_workspace_layout(&workspace_root).expect("ensure layout");
        fs::write(mdreview_path.join("agents").join("codex.json"), "{not json")
            .expect("write corrupt cursor");

        let error = load_agent_cursor(workspace_root.to_str().expect("root str"), "codex")
            .expect_err("direct cursor read should stay strict");

        assert!(error.contains("Unable to parse"));
        fs::remove_dir_all(&workspace_root).expect("cleanup workspace");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nonce}"))
    }
}
