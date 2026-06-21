use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalMutationStatus {
    Accepted,
    Rejected,
    Stale,
}

impl ProposalMutationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Stale => "stale",
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn proposal_record_preserves_unknown_fields_on_round_trip() {
        let record: ProposalRecord = serde_json::from_value(json!({
            "schemaVersion": 2,
            "id": "proposal_future",
            "documentId": "doc_future",
            "threadIds": [],
            "adapterId": "codex",
            "createdAt": "2026-06-20T00:00:00Z",
            "updatedAt": "2026-06-20T00:00:00Z",
            "status": "pending",
            "baseContentHash": "sha256:future",
            "responseMode": "updated_document",
            "summary": "Future proposal",
            "assistantMessage": "Future assistant message",
            "updatedDocumentText": "Updated",
            "unifiedDiff": null,
            "computedDiff": "",
            "warnings": [],
            "resolveThreadIds": [],
            "stderr": null,
            "errorMessage": null,
            "futureField": {"kept": true}
        }))
        .expect("parse future proposal");

        assert_eq!(record.schema_version, 2);
        assert_eq!(
            record.extra.get("futureField"),
            Some(&json!({"kept": true}))
        );

        let serialized = serde_json::to_value(&record).expect("serialize proposal");
        assert_eq!(serialized["futureField"], json!({"kept": true}));
        assert_eq!(serialized["schemaVersion"], json!(2));
    }

    #[test]
    fn proposal_mutation_status_serializes_as_contract_string() {
        assert_eq!(
            serde_json::to_value(ProposalMutationStatus::Accepted).expect("serialize status"),
            json!("accepted")
        );
        assert_eq!(
            serde_json::to_value(ProposalMutationStatus::Rejected).expect("serialize status"),
            json!("rejected")
        );
        assert_eq!(
            serde_json::to_value(ProposalMutationStatus::Stale).expect("serialize status"),
            json!("stale")
        );
    }
}
