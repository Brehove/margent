use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDefinition {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub working_directory_mode: String,
    pub environment_allowlist: Vec<String>,
    pub input_mode: String,
    pub output_mode: String,
    pub capabilities: Vec<String>,
    pub timeout_seconds: u64,
}
