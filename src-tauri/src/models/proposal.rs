use serde::{Deserialize, Serialize};

use crate::models::document::{DocumentPayload, DocumentVersion};
use crate::models::snapshot::DocumentSnapshotRecord;

pub use margent_core::change_set::ReviewChangeSet;
pub use margent_core::proposal::ProposalRecord;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalMutationResult {
    pub proposal: ProposalRecord,
    pub document: Option<DocumentPayload>,
    pub snapshot: Option<DocumentSnapshotRecord>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProposalChangeSetResult {
    Ready {
        proposal: Box<ProposalRecord>,
        change_set: Box<ReviewChangeSet>,
        document_version: DocumentVersion,
    },
    Stale {
        proposal: Box<ProposalRecord>,
        message: String,
    },
    Unsupported {
        proposal: Box<ProposalRecord>,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProposalHunkAcceptResult {
    Applied {
        result: Box<ProposalMutationResult>,
        applied_hunk_ids: Vec<String>,
    },
    Conflict {
        expected_version: DocumentVersion,
        actual_version: DocumentVersion,
        message: String,
    },
    Stale {
        proposal: Box<ProposalRecord>,
        message: String,
    },
}
