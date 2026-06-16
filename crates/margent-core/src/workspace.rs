use serde::{Deserialize, Serialize};

use crate::document::DocumentRecord;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub schema_version: u8,
    pub root_path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub root_path: String,
    pub opened_path: Option<String>,
    pub mdreview_path: String,
    pub selected_relative_path: Option<String>,
    pub documents: Vec<DocumentRecord>,
}
