use serde::{Deserialize, Serialize};

use crate::models::proposal::ProposalRecord;
use crate::models::thread::ThreadRecord;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadProvider {
    Codex,
    Claude,
}

impl ThreadProvider {
    pub fn id(self) -> &'static str {
        match self {
            ThreadProvider::Codex => "codex",
            ThreadProvider::Claude => "claude",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ThreadProvider::Codex => "Codex",
            ThreadProvider::Claude => "Claude Code",
        }
    }

    pub fn env_var(self) -> &'static str {
        match self {
            ThreadProvider::Codex => "CODEX_BIN",
            ThreadProvider::Claude => "CLAUDE_BIN",
        }
    }

    pub fn binary_name(self) -> &'static str {
        match self {
            ThreadProvider::Codex => "codex",
            ThreadProvider::Claude => "claude",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderThreadAction {
    Feedback,
    Revise,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderDocumentAction {
    Feedback,
    Revise,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderThreadActionResult {
    pub thread: ThreadRecord,
    pub proposal: Option<ProposalRecord>,
}
