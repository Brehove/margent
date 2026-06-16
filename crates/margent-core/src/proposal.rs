use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalRecord {
    pub schema_version: u8,
    pub id: String,
    pub document_id: String,
    pub thread_ids: Vec<String>,
    pub adapter_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub base_content_hash: String,
    pub response_mode: String,
    pub summary: String,
    pub assistant_message: String,
    pub updated_document_text: Option<String>,
    pub unified_diff: Option<String>,
    pub computed_diff: String,
    pub warnings: Vec<String>,
    pub resolve_thread_ids: Vec<String>,
    pub stderr: Option<String>,
    pub error_message: Option<String>,
}
