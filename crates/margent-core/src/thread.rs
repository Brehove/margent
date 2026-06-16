use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FootnoteAnchorMetadata {
    pub label: String,
    pub occurrence: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRecord {
    pub quote: String,
    pub prefix_context: String,
    pub suffix_context: String,
    pub start_offset_utf16: usize,
    pub end_offset_utf16: usize,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub heading_path: Vec<String>,
    pub block_fingerprint: String,
    pub base_content_hash: String,
    #[serde(default = "default_anchor_kind")]
    pub kind: String,
    #[serde(default)]
    pub footnote: Option<FootnoteAnchorMetadata>,
    #[serde(default = "default_anchor_state")]
    pub state: String,
    #[serde(default = "default_anchor_confidence")]
    pub confidence: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub thread_id: String,
    pub author_type: String,
    pub author_name: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub adapter_id: Option<String>,
    #[serde(default)]
    pub reply_to_message_id: Option<String>,
    pub created_at: String,
    pub body: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    #[serde(default = "default_thread_schema_version")]
    pub schema_version: u8,
    pub id: String,
    pub document_id: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub title: String,
    pub tags: Vec<String>,
    pub anchor: AnchorRecord,
    #[serde(default)]
    pub created_content_hash: Option<String>,
    #[serde(default)]
    pub last_reanchor_content_hash: Option<String>,
    #[serde(default)]
    pub review_round: Option<String>,
    #[serde(default)]
    pub review_done: bool,
    pub messages: Vec<MessageRecord>,
    pub linked_proposal_ids: Vec<String>,
    #[serde(default)]
    pub provider_sessions: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummaryRecord {
    #[serde(default = "default_thread_schema_version")]
    pub schema_version: u8,
    pub id: String,
    pub document_id: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub title: String,
    pub tags: Vec<String>,
    pub anchor: AnchorRecord,
    #[serde(default)]
    pub created_content_hash: Option<String>,
    #[serde(default)]
    pub last_reanchor_content_hash: Option<String>,
    #[serde(default)]
    pub review_round: Option<String>,
    #[serde(default)]
    pub review_done: bool,
    pub linked_proposal_ids: Vec<String>,
    #[serde(default)]
    pub provider_sessions: HashMap<String, String>,
}

fn default_anchor_state() -> String {
    "attached".into()
}

fn default_anchor_kind() -> String {
    "text_span".into()
}

fn default_anchor_confidence() -> f32 {
    1.0
}

fn default_thread_schema_version() -> u8 {
    CURRENT_THREAD_SCHEMA_VERSION
}

pub const CURRENT_THREAD_SCHEMA_VERSION: u8 = 6;
