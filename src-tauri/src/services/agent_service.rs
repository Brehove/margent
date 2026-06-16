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

        if let Some(cursor) = file_service::read_optional_json::<AgentCursorRecord>(&path)? {
            cursors.push(cursor);
        }
    }

    Ok(cursors)
}
