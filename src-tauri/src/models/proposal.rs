use serde::{Deserialize, Serialize};

use crate::models::document::DocumentPayload;

pub use margent_core::proposal::ProposalRecord;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalMutationResult {
    pub proposal: ProposalRecord,
    pub document: Option<DocumentPayload>,
    pub message: Option<String>,
}
