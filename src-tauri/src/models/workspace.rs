use serde::{Deserialize, Serialize};

pub use margent_core::workspace::{WorkspaceRecord, WorkspaceSnapshot};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenRequest {
    pub id: u64,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportResult {
    pub absolute_path: String,
    pub relative_path: String,
}
