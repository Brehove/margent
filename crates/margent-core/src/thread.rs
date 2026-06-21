use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
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
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn thread_json(schema_version: u8) -> serde_json::Value {
        json!({
            "schemaVersion": schema_version,
            "id": "thread_future",
            "documentId": "doc_future",
            "status": "open",
            "createdAt": "2026-06-20T00:00:00Z",
            "updatedAt": "2026-06-20T00:00:00Z",
            "createdBy": "user",
            "title": "Future thread",
            "tags": [],
            "anchor": {
                "quote": "future",
                "prefixContext": "",
                "suffixContext": "",
                "startOffsetUtf16": 0,
                "endOffsetUtf16": 6,
                "startLine": 1,
                "startColumn": 1,
                "endLine": 1,
                "endColumn": 7,
                "headingPath": [],
                "blockFingerprint": "sha256:future",
                "baseContentHash": "sha256:future",
                "kind": "text_span",
                "state": "attached",
                "confidence": 1.0
            },
            "createdContentHash": "sha256:future",
            "lastReanchorContentHash": "sha256:future",
            "reviewDone": false,
            "messages": [],
            "linkedProposalIds": [],
            "providerSessions": {},
            "futureField": {"kept": true}
        })
    }

    #[test]
    fn thread_record_preserves_unknown_fields_on_round_trip() {
        let record: ThreadRecord =
            serde_json::from_value(thread_json(CURRENT_THREAD_SCHEMA_VERSION + 1))
                .expect("parse future thread");

        assert_eq!(record.schema_version, CURRENT_THREAD_SCHEMA_VERSION + 1);
        assert_eq!(
            record.extra.get("futureField"),
            Some(&json!({"kept": true}))
        );

        let serialized = serde_json::to_value(&record).expect("serialize thread");
        assert_eq!(serialized["futureField"], json!({"kept": true}));
        assert_eq!(
            serialized["schemaVersion"],
            json!(CURRENT_THREAD_SCHEMA_VERSION + 1)
        );
    }

    #[test]
    fn thread_summary_record_preserves_unknown_fields_on_round_trip() {
        let record: ThreadSummaryRecord =
            serde_json::from_value(thread_json(CURRENT_THREAD_SCHEMA_VERSION + 1))
                .expect("parse future thread summary");

        assert_eq!(record.schema_version, CURRENT_THREAD_SCHEMA_VERSION + 1);
        assert_eq!(
            record.extra.get("futureField"),
            Some(&json!({"kept": true}))
        );

        let serialized = serde_json::to_value(&record).expect("serialize thread summary");
        assert_eq!(serialized["futureField"], json!({"kept": true}));
        assert_eq!(
            serialized["schemaVersion"],
            json!(CURRENT_THREAD_SCHEMA_VERSION + 1)
        );
    }
}
