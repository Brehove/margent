use std::env;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Codex,
    Claude,
}

impl ProviderKind {
    pub fn all() -> [ProviderKind; 2] {
        [ProviderKind::Codex, ProviderKind::Claude]
    }

    pub fn id(self) -> &'static str {
        match self {
            ProviderKind::Codex => "codex",
            ProviderKind::Claude => "claude",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ProviderKind::Codex => "Codex",
            ProviderKind::Claude => "Claude Code",
        }
    }

    pub fn binary_name(self) -> &'static str {
        match self {
            ProviderKind::Codex => "codex",
            ProviderKind::Claude => "claude",
        }
    }

    pub fn env_var(self) -> &'static str {
        match self {
            ProviderKind::Codex => "CODEX_BIN",
            ProviderKind::Claude => "CLAUDE_BIN",
        }
    }

    pub fn docs_url(self) -> &'static str {
        match self {
            ProviderKind::Codex => "https://developers.openai.com/codex/cli",
            ProviderKind::Claude => "https://docs.anthropic.com/en/docs/claude-code/quickstart",
        }
    }

    pub fn auth_docs_url(self) -> &'static str {
        match self {
            ProviderKind::Codex => "https://developers.openai.com/codex/cli/reference#codex-login",
            ProviderKind::Claude => "https://docs.anthropic.com/en/docs/claude-code/iam",
        }
    }

    pub fn install_command(self) -> &'static str {
        match self {
            ProviderKind::Codex => "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            ProviderKind::Claude => "curl -fsSL https://claude.ai/install.sh | bash",
        }
    }

    pub fn login_command(self) -> &'static str {
        match self {
            ProviderKind::Codex => "codex login",
            ProviderKind::Claude => "claude auth login",
        }
    }

    pub fn auth_check_command(self) -> &'static str {
        match self {
            ProviderKind::Codex => "codex login status",
            ProviderKind::Claude => "claude auth status",
        }
    }

    fn auth_status_args(self) -> &'static [&'static str] {
        match self {
            ProviderKind::Codex => &["login", "status"],
            ProviderKind::Claude => &["auth", "status"],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderReadinessStatus {
    Ready,
    Missing,
    Unauthenticated,
    AuthCheckFailed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReadiness {
    pub id: String,
    pub display_name: String,
    pub binary_name: String,
    pub env_var: String,
    pub installed: bool,
    pub authenticated: bool,
    pub ready: bool,
    pub status: ProviderReadinessStatus,
    pub binary_path: Option<String>,
    pub docs_url: String,
    pub auth_docs_url: String,
    pub install_command: String,
    pub login_command: String,
    pub auth_check_command: String,
    pub next_step: Option<String>,
    pub check_error: Option<String>,
}

pub fn inspect_providers() -> Vec<ProviderReadiness> {
    ProviderKind::all()
        .into_iter()
        .map(inspect_provider)
        .collect()
}

pub fn inspect_provider(provider: ProviderKind) -> ProviderReadiness {
    let binary_path = resolve_provider_binary_path(provider);
    let installed = binary_path.is_some();
    let mut authenticated = false;
    let mut auth_check_failed = false;
    let mut check_error = None;

    if let Some(binary_path) = binary_path.as_ref() {
        match Command::new(binary_path)
            .args(provider.auth_status_args())
            .output()
        {
            Ok(output) => {
                authenticated = output.status.success();
                if !authenticated {
                    let message = provider_check_message(&output.stdout, &output.stderr);
                    if !message.is_empty() {
                        check_error = Some(message);
                    }
                }
            }
            Err(error) => {
                auth_check_failed = true;
                check_error = Some(format!("Unable to run auth check: {error}"));
            }
        }
    }

    let status = if !installed {
        ProviderReadinessStatus::Missing
    } else if authenticated {
        ProviderReadinessStatus::Ready
    } else if auth_check_failed {
        ProviderReadinessStatus::AuthCheckFailed
    } else {
        ProviderReadinessStatus::Unauthenticated
    };
    let ready = status == ProviderReadinessStatus::Ready;
    let next_step = provider_next_step(provider, &status);

    ProviderReadiness {
        id: provider.id().to_string(),
        display_name: provider.display_name().to_string(),
        binary_name: provider.binary_name().to_string(),
        env_var: provider.env_var().to_string(),
        installed,
        authenticated,
        ready,
        status,
        binary_path: binary_path.map(|path| path.display().to_string()),
        docs_url: provider.docs_url().to_string(),
        auth_docs_url: provider.auth_docs_url().to_string(),
        install_command: provider.install_command().to_string(),
        login_command: provider.login_command().to_string(),
        auth_check_command: provider.auth_check_command().to_string(),
        next_step,
        check_error,
    }
}

pub fn resolve_provider_binary_path(provider: ProviderKind) -> Option<PathBuf> {
    if let Ok(path) = env::var(provider.env_var()) {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Some(path) = resolve_with_command("which", &[provider.binary_name()]) {
        return Some(path);
    }

    let zsh_lookup = format!("command -v {}", provider.binary_name());
    if let Some(path) = resolve_with_command("/bin/zsh", &["-lc", &zsh_lookup]) {
        return Some(path);
    }

    let mut candidates = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{}", provider.binary_name())),
        PathBuf::from(format!("/usr/local/bin/{}", provider.binary_name())),
    ];
    if let Ok(home) = env::var("HOME") {
        let home_path = PathBuf::from(home);
        candidates.push(home_path.join(format!(".local/bin/{}", provider.binary_name())));
        candidates.push(home_path.join(format!(".npm-global/bin/{}", provider.binary_name())));
    }

    candidates.into_iter().find(|candidate| candidate.exists())
}

fn resolve_with_command(command: &str, args: &[&str]) -> Option<PathBuf> {
    let output = Command::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn provider_check_message(stdout: &[u8], stderr: &[u8]) -> String {
    let raw = if stderr.is_empty() { stdout } else { stderr };
    String::from_utf8_lossy(raw)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

fn provider_next_step(provider: ProviderKind, status: &ProviderReadinessStatus) -> Option<String> {
    match status {
        ProviderReadinessStatus::Ready => None,
        ProviderReadinessStatus::Missing => Some(format!(
            "{}: NOT installed -> run `{}` (see {}).",
            provider.display_name(),
            provider.install_command(),
            provider.docs_url()
        )),
        ProviderReadinessStatus::Unauthenticated => Some(format!(
            "{}: NOT authenticated -> run `{}` (see {}).",
            provider.display_name(),
            provider.login_command(),
            provider.auth_docs_url()
        )),
        ProviderReadinessStatus::AuthCheckFailed => Some(format!(
            "{}: auth check failed -> run `{}`; if needed, re-authenticate with `{}` (see {}).",
            provider.display_name(),
            provider.auth_check_command(),
            provider.login_command(),
            provider.auth_docs_url()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{inspect_providers, provider_next_step, ProviderKind, ProviderReadinessStatus};

    #[test]
    fn remediation_messages_are_actionable() {
        let missing = provider_next_step(ProviderKind::Codex, &ProviderReadinessStatus::Missing)
            .expect("missing next step");
        assert!(missing.contains("codex/install.sh"));
        assert!(missing.contains("https://developers.openai.com/codex/cli"));

        let unauthenticated = provider_next_step(
            ProviderKind::Claude,
            &ProviderReadinessStatus::Unauthenticated,
        )
        .expect("auth next step");
        assert!(unauthenticated.contains("claude auth login"));
        assert!(unauthenticated.contains("https://docs.anthropic.com/en/docs/claude-code/iam"));
    }

    #[test]
    fn provider_snapshot_lists_codex_and_claude() {
        let ids: Vec<_> = inspect_providers()
            .into_iter()
            .map(|provider| provider.id)
            .collect();
        assert_eq!(ids, vec!["codex", "claude"]);
    }
}
