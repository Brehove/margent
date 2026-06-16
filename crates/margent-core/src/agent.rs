use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCursorRecord {
    pub agent_id: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub adapter_id: Option<String>,
    #[serde(default)]
    pub last_seen_event_id: Option<String>,
    #[serde(default)]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub last_sync_status: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}
