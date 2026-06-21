use serde::{Deserialize, Serialize};

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
