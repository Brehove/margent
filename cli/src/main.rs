mod actions;
mod anchor_service;
mod critic;
mod export;
mod mcp;
mod models;
mod provider;
mod serve;
mod workspace;

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::mpsc;

use clap::{Args, Parser, Subcommand, ValueEnum};
use margent_core::deep_link::{document_deep_link, thread_deep_link};
use margent_core::provider_readiness::{inspect_providers, ProviderReadinessStatus};
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{json, Value};

use provider::Provider;

// ── CLI definition ──────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "margent",
    about = "Margent CLI — AI-assisted Markdown review from the terminal",
    version
)]
struct Cli {
    /// Emit machine-readable JSON where supported. Can be placed before or after subcommands.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Args, Clone, Debug)]
struct ThreadSelectorArgs {
    /// Thread ordinal (1-based, sorted by creation time)
    #[arg(
        value_name = "ORDINAL",
        required_unless_present = "id",
        conflicts_with = "id"
    )]
    ordinal: Option<usize>,

    /// Stable thread ID from `margent threads list`
    #[arg(long, value_name = "THREAD_ID", conflicts_with = "ordinal")]
    id: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Verify margent is on PATH and optionally install agent skills
    Install {
        /// Install the shared Margent skill into Claude Code and Codex skill directories
        #[arg(long)]
        agent_skills: bool,

        /// Replace an existing installed Margent skill
        #[arg(long)]
        force: bool,
    },

    /// Initialize .mdreview/ in the current directory
    Init {
        /// Also write local MCP registration snippets (.mcp.json and .codex/config.toml)
        #[arg(long)]
        write_config: bool,
    },

    /// Check codex/claude availability and auth status
    Doctor,

    /// Open a Markdown document, or a specific thread, in the Margent desktop app
    Open {
        /// Markdown document path, absolute or relative to the current directory
        document: String,

        /// Stable thread ID to select after opening the document
        #[arg(long)]
        thread: Option<String>,

        /// Print the target without launching Margent
        #[arg(long)]
        print_only: bool,
    },

    /// Distill resolved review history into .mdreview/memory.md
    Codify {
        /// Provider to use for distillation
        #[arg(long, value_enum, default_value_t = AgentIdentity::Codex)]
        provider: AgentIdentity,

        /// Print the proposed memory update without writing or advancing the cursor
        #[arg(long)]
        dry_run: bool,
    },

    /// Revert the latest Margent document snapshot
    RevertLast {
        /// Relative path to the document; defaults to the most recent snapshot across documents
        #[arg(long)]
        document: Option<String>,
    },

    /// Refresh persisted thread anchors against current document text
    Reanchor {
        /// Relative path to one indexed document; defaults to all indexed documents
        #[arg(long)]
        document: Option<String>,

        /// Exit non-zero when any open thread anchor needs review or is detached
        #[arg(long)]
        check: bool,

        /// Report anchor movements without writing updated thread records
        #[arg(long)]
        dry_run: bool,
    },

    /// Normalize legacy thread records in the current workspace
    Migrate,

    /// Event-log operations
    Events {
        #[command(subcommand)]
        action: EventsAction,
    },

    /// Proposal operations
    Proposals {
        #[command(subcommand)]
        action: ProposalsAction,
    },

    /// Markdown file operations
    Files {
        #[command(subcommand)]
        action: FilesAction,
    },

    /// Export a Markdown document to HTML, DOCX, PDF instructions, or Google Docs
    Export {
        /// Relative path to the document
        document: String,

        /// Export format; defaults to html (for Google Docs, html converts with native tables and inlined images; docx is available explicitly)
        #[arg(long, value_enum)]
        format: Option<export::ExportFormat>,

        /// Upload with Google Docs conversion through the gws CLI
        #[arg(long)]
        gdoc: bool,

        /// Output path for file export, or intermediate file path for --gdoc
        #[arg(long, value_name = "PATH")]
        output: Option<PathBuf>,
    },

    /// Export a Markdown document copy with CriticMarkup comments and suggestions
    ExportCritic {
        /// Relative path to the document
        document: String,

        /// Output path for the CriticMarkup copy
        #[arg(long, value_name = "PATH")]
        output: Option<PathBuf>,

        /// Include resolved threads as comments
        #[arg(long)]
        include_resolved: bool,
    },

    /// Import CriticMarkup comments and suggestions back into Margent sidecars
    ImportCritic {
        /// Path to the CriticMarkup Markdown copy
        critic_file: PathBuf,

        /// Relative path to the source document
        #[arg(long)]
        document: String,

        /// Show what would be imported without writing sidecars
        #[arg(long)]
        dry_run: bool,

        /// Author name for imported comments
        #[arg(long, default_value = "CriticMarkup Import")]
        author_name: String,
    },

    /// Run a Model Context Protocol server over stdio
    Mcp {
        /// Workspace root, or any path inside an existing Margent workspace
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Serve a localhost browser UI and JSON API for this workspace
    Serve {
        /// Workspace root, or any path inside an existing Margent workspace
        #[arg(long)]
        workspace: Option<PathBuf>,

        /// Localhost port to bind
        #[arg(long, default_value_t = 7345)]
        port: u16,

        /// Bearer token for API/browser access; generated when omitted
        #[arg(long)]
        token: Option<String>,
    },

    /// Thread operations
    Threads {
        #[command(subcommand)]
        action: ThreadsAction,
    },

    /// Codex provider operations
    Codex {
        #[command(subcommand)]
        action: ProviderAction,
    },

    /// Claude provider operations
    Claude {
        #[command(subcommand)]
        action: ProviderAction,
    },
}

#[derive(Subcommand)]
enum EventsAction {
    /// Print existing events and optionally follow future events
    Tail {
        /// Continue streaming new event-log entries after existing entries are printed
        #[arg(long)]
        follow: bool,

        /// Only print events after this event ID
        #[arg(long)]
        since: Option<String>,
    },
}

#[derive(Subcommand)]
enum ProposalsAction {
    /// List proposals, optionally limited to one document
    List {
        /// Relative path to the document
        #[arg(long)]
        document: Option<String>,

        /// Only include proposals with this status
        #[arg(long)]
        status: Option<String>,
    },

    /// Show one proposal by stable proposal ID
    Show {
        /// Stable proposal ID
        id: String,
    },

    /// Accept a pending proposal and apply its document text
    Accept {
        /// Stable proposal ID
        id: String,
    },

    /// Reject a pending or stale proposal
    Reject {
        /// Stable proposal ID
        id: String,
    },
}

#[derive(Subcommand)]
enum FilesAction {
    /// List indexed Markdown files
    List,

    /// Print a Markdown file from the active workspace
    Read {
        /// Relative path to the document
        document: String,
    },

    /// Create a new Markdown file in the active workspace
    Create {
        /// Relative path for the new document
        document: String,

        /// Initial document content
        #[arg(long, default_value = "")]
        content: String,
    },

    /// Rename a Markdown file in the active workspace
    Rename {
        /// Current relative path
        from: String,

        /// New relative path
        to: String,
    },

    /// Delete a Markdown file and its sidecars
    Delete {
        /// Relative path to delete
        document: String,

        /// Confirm deletion of the file and its sidecars
        #[arg(long)]
        yes: bool,
    },

    /// Print the document heading index
    Outline {
        /// Relative path to the document
        document: String,
    },
}

#[derive(Subcommand)]
enum ThreadsAction {
    /// List threads for a document
    List {
        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,
    },

    /// Show thread detail by ordinal or stable thread ID
    Show {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,
    },

    /// Create a new thread anchored to a quote in the document
    Add {
        /// Quote to anchor the thread to
        #[arg(long)]
        quote: String,

        /// Initial comment body
        #[arg(long)]
        body: String,

        /// Optional thread title (defaults to a quote-derived title)
        #[arg(long)]
        title: Option<String>,

        /// Which occurrence of the quote to anchor to (1-based)
        #[arg(long, default_value_t = 1)]
        occurrence: usize,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,

        /// Attribute the new thread to an agent instead of the local user
        #[arg(long, value_enum)]
        agent: Option<AgentIdentity>,
    },

    /// Add a reply to an existing thread
    Reply {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Reply body
        #[arg(long)]
        body: String,

        /// Optional message ordinal to reply to (1-based)
        #[arg(long)]
        reply_to: Option<usize>,

        /// Message kind to store
        #[arg(long, default_value = "reply")]
        kind: String,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,

        /// Attribute the reply to an agent instead of the local user
        #[arg(long, value_enum)]
        agent: Option<AgentIdentity>,
    },

    /// Delete an entire thread
    Delete {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,

        /// Confirm deletion of the entire thread
        #[arg(long)]
        yes: bool,
    },

    /// Delete a single message from a thread
    DeleteMessage {
        /// Thread ordinal (1-based, sorted by creation time)
        ordinal: usize,

        /// Message ordinal within the thread (1-based)
        message: usize,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,

        /// Confirm deletion of the message
        #[arg(long)]
        yes: bool,
    },

    /// Resolve a thread
    Resolve {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,
    },

    /// Reopen a resolved thread
    Reopen {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,
    },
}

#[derive(Subcommand)]
enum ProviderAction {
    /// Create a new thread as this provider
    Comment {
        /// Quote to anchor the thread to
        #[arg(long)]
        quote: String,

        /// Initial comment body
        #[arg(long)]
        body: String,

        /// Optional thread title (defaults to a quote-derived title)
        #[arg(long)]
        title: Option<String>,

        /// Which occurrence of the quote to anchor to (1-based)
        #[arg(long, default_value_t = 1)]
        occurrence: usize,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,
    },

    /// Reply to an existing thread as this provider
    Reply {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Reply body
        #[arg(long)]
        body: String,

        /// Optional message ordinal to reply to (1-based)
        #[arg(long)]
        reply_to: Option<usize>,

        /// Message kind to store
        #[arg(long, default_value = "reply")]
        kind: String,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,
    },

    /// Get feedback from the provider on a thread
    Feedback {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Additional instruction for the provider
        #[arg(long)]
        instruction: Option<String>,

        /// Workspace review pass from .mdreview/skills/<name>.md
        #[arg(long = "pass", value_name = "PASS_NAME")]
        pass: Option<String>,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,

        /// Stream provider output as it arrives
        #[arg(long)]
        stream: bool,
    },

    /// Get a revision proposal from the provider for a thread
    Revise {
        #[command(flatten)]
        thread: ThreadSelectorArgs,

        /// Additional instruction for the provider
        #[arg(long)]
        instruction: Option<String>,

        /// Workspace review pass from .mdreview/skills/<name>.md
        #[arg(long = "pass", value_name = "PASS_NAME")]
        pass: Option<String>,

        /// Relative path to the document (auto-detected if only one exists)
        #[arg(long)]
        document: Option<String>,

        /// Apply the returned revision directly to disk after saving it to proposal history
        #[arg(long)]
        apply: bool,

        /// Resolve the thread immediately after a direct apply
        #[arg(long)]
        resolve: bool,

        /// Stream provider output as it arrives
        #[arg(long)]
        stream: bool,
    },

    /// Full sync cycle: process new events and generate responses
    Sync {
        /// Workspace review pass from .mdreview/skills/<name>.md
        #[arg(long = "pass", value_name = "PASS_NAME")]
        pass: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum AgentIdentity {
    Codex,
    Claude,
}

impl AgentIdentity {
    fn id(self) -> &'static str {
        match self {
            AgentIdentity::Codex => "codex",
            AgentIdentity::Claude => "claude",
        }
    }

    fn author_name(self) -> &'static str {
        match self {
            AgentIdentity::Codex => "Codex",
            AgentIdentity::Claude => "Claude",
        }
    }

    fn provider(self) -> Provider {
        match self {
            AgentIdentity::Codex => Provider::Codex,
            AgentIdentity::Claude => Provider::Claude,
        }
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
    let cli = Cli::parse();
    let output = OutputFormat::from_json_flag(cli.json);

    let result = match cli.command {
        Commands::Install {
            agent_skills,
            force,
        } => cmd_install(output, agent_skills, force),
        Commands::Init { write_config } => cmd_init(output, write_config),
        Commands::Doctor => cmd_doctor(output),
        Commands::Open {
            document,
            thread,
            print_only,
        } => cmd_open(&document, thread.as_deref(), print_only, output),
        Commands::Codify { provider, dry_run } => cmd_codify(provider.provider(), dry_run, output),
        Commands::RevertLast { document } => cmd_revert_last(document.as_deref(), output),
        Commands::Reanchor {
            document,
            check,
            dry_run,
        } => cmd_reanchor(document.as_deref(), check, dry_run, output),
        Commands::Migrate => cmd_migrate(output),
        Commands::Events { action } => cmd_events(action, output),
        Commands::Proposals { action } => cmd_proposals(action, output),
        Commands::Files { action } => cmd_files(action, output),
        Commands::Export {
            document,
            format,
            gdoc,
            output: export_output,
        } => cmd_export(&document, format, gdoc, export_output.as_deref(), output),
        Commands::ExportCritic {
            document,
            output: export_output,
            include_resolved,
        } => cmd_export_critic(
            &document,
            export_output.as_deref(),
            include_resolved,
            output,
        ),
        Commands::ImportCritic {
            critic_file,
            document,
            dry_run,
            author_name,
        } => cmd_import_critic(&critic_file, &document, dry_run, &author_name, output),
        Commands::Mcp { workspace } => mcp::run(workspace),
        Commands::Serve {
            workspace,
            port,
            token,
        } => serve::run(workspace, port, token),
        Commands::Threads { action } => cmd_threads(action, output),
        Commands::Codex { action } => cmd_provider(Provider::Codex, action, output),
        Commands::Claude { action } => cmd_provider(Provider::Claude, action, output),
    };

    if let Err(e) = result {
        if output.is_json() {
            eprintln!("{}", json!({ "error": e }));
        } else {
            eprintln!("Error: {e}");
        }
        process::exit(1);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputFormat {
    Human,
    Json,
}

impl OutputFormat {
    fn from_json_flag(json: bool) -> Self {
        if json {
            Self::Json
        } else {
            Self::Human
        }
    }

    fn is_json(self) -> bool {
        matches!(self, Self::Json)
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Unable to serialize JSON output: {error}"))?;
    println!("{body}");
    Ok(())
}

fn print_json_line<T: Serialize>(value: &T) -> Result<(), String> {
    let body = serde_json::to_string(value)
        .map_err(|error| format!("Unable to serialize JSON output: {error}"))?;
    println!("{body}");
    Ok(())
}

fn thread_with_deep_link(
    root: &Path,
    document_relative_path: &str,
    thread: &models::ThreadRecord,
) -> Value {
    let mut value = serde_json::to_value(thread).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut value {
        map.insert(
            "deepLink".to_string(),
            json!(thread_deep_link(
                root.to_string_lossy().as_ref(),
                document_relative_path,
                &thread.id,
            )),
        );
    }
    value
}

// ── install ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct AgentSkillInstallReport {
    agent: &'static str,
    target: String,
    status: &'static str,
    detail: String,
}

fn cmd_install(output: OutputFormat, agent_skills: bool, force: bool) -> Result<(), String> {
    let exe =
        env::current_exe().map_err(|e| format!("Unable to determine binary location: {e}"))?;
    let exe_str = exe.to_string_lossy();

    // Check if margent is on PATH
    let on_path = std::process::Command::new("which")
        .arg("margent")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let agent_skill_results = if agent_skills {
        install_agent_skills(force)?
    } else {
        Vec::new()
    };

    if output.is_json() {
        return print_json(&json!({
            "binaryLocation": exe_str,
            "homebrewInstall": "brew tap Brehove/margent https://github.com/Brehove/margent && brew install margent",
            "homebrewTap": "Brehove/margent",
            "onPath": on_path,
            "pathHint": exe.parent().map(|parent| parent.to_string_lossy().to_string()),
            "agentSkills": agent_skill_results,
        }));
    }

    println!("Binary location: {exe_str}");
    println!(
        "Homebrew install:\n  brew tap Brehove/margent https://github.com/Brehove/margent\n  brew install margent"
    );

    if on_path {
        println!("margent is on PATH.");
    } else {
        println!("margent is NOT on PATH.");
        if let Some(parent) = exe.parent() {
            println!(
                "Add this to your shell profile:\n  export PATH=\"{}:$PATH\"",
                parent.display()
            );
        }
    }

    if agent_skills {
        println!("Agent skill install:");
        for result in &agent_skill_results {
            println!("  {}: {} ({})", result.agent, result.target, result.status);
            println!("    {}", result.detail);
        }
    } else {
        println!("Agent skill install:");
        println!("  Run `margent install --agent-skills` to copy the shared skill into Claude Code and Codex.");
    }

    Ok(())
}

fn install_agent_skills(force: bool) -> Result<Vec<AgentSkillInstallReport>, String> {
    let home = env::var_os("HOME").ok_or_else(|| "Unable to determine HOME".to_string())?;
    let home = PathBuf::from(home);

    let targets = [
        (
            "Claude Code",
            home.join(".claude").join("skills").join("margent"),
        ),
        ("Codex", home.join(".codex").join("skills").join("margent")),
    ];

    targets
        .into_iter()
        .map(|(agent, target)| install_one_agent_skill(agent, &target, force))
        .collect()
}

fn install_one_agent_skill(
    agent: &'static str,
    target: &Path,
    force: bool,
) -> Result<AgentSkillInstallReport, String> {
    if fs::symlink_metadata(target).is_ok() {
        if !force {
            return Ok(AgentSkillInstallReport {
                agent,
                target: target.to_string_lossy().to_string(),
                status: "skipped",
                detail: "Existing skill left untouched; rerun with --force to replace it.".into(),
            });
        }
        remove_existing_path(target)?;
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Unable to determine parent for {}", target.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
    fs::create_dir_all(target.join("agents"))
        .map_err(|error| format!("Unable to create {}: {error}", target.display()))?;

    fs::write(target.join("SKILL.md"), MARGENT_SKILL_TEMPLATE)
        .map_err(|error| format!("Unable to write SKILL.md: {error}"))?;
    fs::write(target.join("README.md"), MARGENT_SKILL_README)
        .map_err(|error| format!("Unable to write README.md: {error}"))?;
    fs::write(
        target.join("agents").join("openai.yaml"),
        MARGENT_OPENAI_METADATA,
    )
    .map_err(|error| format!("Unable to write openai.yaml: {error}"))?;

    Ok(AgentSkillInstallReport {
        agent,
        target: target.to_string_lossy().to_string(),
        status: "installed",
        detail: "Installed the shared Margent agent skill.".into(),
    })
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?;
    let file_type = metadata.file_type();

    if file_type.is_symlink() || metadata.is_file() {
        fs::remove_file(path)
            .map_err(|error| format!("Unable to remove {}: {error}", path.display()))
    } else if metadata.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Unable to remove {}: {error}", path.display()))
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("Unable to remove {}: {error}", path.display()))
    }
}

// ── desktop open ─────────────────────────────────────────────────────────────

fn cmd_open(
    document: &str,
    thread_id: Option<&str>,
    print_only: bool,
    output: OutputFormat,
) -> Result<(), String> {
    let input_path = PathBuf::from(document);
    let absolute_path = if input_path.is_absolute() {
        input_path
    } else {
        env::current_dir()
            .map_err(|error| format!("Unable to read current directory: {error}"))?
            .join(input_path)
    };
    let absolute_path = absolute_path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve {document}: {error}"))?;

    let workspace_root = workspace::find_workspace_root(&absolute_path).ok();
    let (target, target_kind) = if let Some(root) = workspace_root.as_ref() {
        let relative_path = absolute_path
            .strip_prefix(root)
            .map_err(|error| format!("Unable to derive workspace-relative path: {error}"))?
            .to_string_lossy()
            .replace('\\', "/");
        let workspace_root = root.to_string_lossy();
        let link = thread_id
            .map(|id| thread_deep_link(workspace_root.as_ref(), &relative_path, id))
            .unwrap_or_else(|| document_deep_link(workspace_root.as_ref(), &relative_path));
        (link, "deep_link")
    } else {
        (absolute_path.to_string_lossy().to_string(), "file")
    };

    if !print_only {
        let mut command = process::Command::new("open");
        if target_kind == "deep_link" {
            command.arg(&target);
        } else {
            command.arg("-a").arg("Margent").arg(&target);
        }
        let status = command
            .status()
            .map_err(|error| format!("Unable to launch Margent with macOS open: {error}"))?;
        if !status.success() {
            return Err(format!("macOS open exited with status {status}."));
        }
    }

    if output.is_json() {
        return print_json(&json!({
            "opened": !print_only,
            "target": target,
            "targetKind": target_kind,
            "threadId": thread_id,
        }));
    }

    if print_only {
        println!("{target}");
    } else {
        println!("Opened {target}");
    }
    Ok(())
}

// ── codify ──────────────────────────────────────────────────────────────────

fn cmd_codify(provider: Provider, dry_run: bool, output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;

    if !output.is_json() {
        if dry_run {
            println!(
                "Codifying review memory with {} (dry run)...",
                provider.display_name()
            );
        } else {
            println!(
                "Codifying review memory with {}...",
                provider.display_name()
            );
        }
    }

    let result = actions::run_codify(&root, provider, dry_run)?;

    if output.is_json() {
        return print_json(&result);
    }

    if result.relevant_events == 0 {
        println!(
            "No resolved threads or proposal decisions to codify across {} new event(s).",
            result.processed_events
        );
        return Ok(());
    }

    if dry_run {
        println!(
            "Would update {} from {} relevant event(s):",
            result.memory_path, result.relevant_events
        );
    } else if result.changed {
        println!(
            "Updated {} from {} relevant event(s).",
            result.memory_path, result.relevant_events
        );
    } else {
        println!(
            "{} already matches the distilled memory from {} relevant event(s).",
            result.memory_path, result.relevant_events
        );
    }

    if let Some(memory) = result.memory.as_deref() {
        if dry_run || result.changed {
            println!();
            println!("{memory}");
        }
    }
    Ok(())
}

// ── init ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitScaffoldSummary {
    created_files: Vec<String>,
    existing_files: Vec<String>,
    mcp_json: String,
    codex_config_toml: String,
}

fn cmd_init(output: OutputFormat, write_config: bool) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;

    if !output.is_json() {
        println!("Initializing Margent workspace in {}", cwd.display());
    }

    // 1. Create .mdreview/ layout
    let mdreview = workspace::ensure_workspace_layout(&cwd)?;
    if !output.is_json() {
        println!("  Created {}/", mdreview.display());
    }

    // 2. Scan and register existing markdown files
    let md_files = workspace::list_markdown_files(&cwd)?;
    let mut indexed_documents = Vec::new();
    for file in &md_files {
        let rel = workspace::relative_path_string(&cwd, file)?;
        let content = fs::read_to_string(file)
            .map_err(|e| format!("Unable to read {}: {e}", file.display()))?;
        workspace::upsert_document_record(&cwd, &rel, &content)?;
        indexed_documents.push(rel.clone());
        if !output.is_json() {
            println!("  Indexed document: {rel}");
        }
    }

    let scaffold = write_agent_package(&cwd, write_config)?;
    if !output.is_json() {
        for file in &scaffold.created_files {
            println!("  Created {file}");
        }
        for file in &scaffold.existing_files {
            println!("  Left existing {file} untouched");
        }
    }

    // 3. Agent cursor scaffolding
    let mut created_agent_cursors = Vec::new();
    for agent_id in &["codex", "claude"] {
        if workspace::load_agent_cursor(&cwd, agent_id)?.is_none() {
            let cursor = models::AgentCursorRecord {
                agent_id: agent_id.to_string(),
                provider_id: None,
                adapter_id: None,
                last_seen_event_id: None,
                last_synced_at: None,
                last_sync_status: None,
                notes: None,
            };
            workspace::save_agent_cursor(&cwd, &cursor)?;
            created_agent_cursors.push(*agent_id);
            if !output.is_json() {
                println!("  Created agent cursor: {agent_id}");
            }
        }
    }

    if output.is_json() {
        return print_json(&json!({
            "workspaceRoot": cwd,
            "mdreviewPath": mdreview,
            "indexedDocuments": indexed_documents,
            "documentCount": md_files.len(),
            "createdFiles": scaffold.created_files,
            "existingFiles": scaffold.existing_files,
            "writeConfig": write_config,
            "mcpJson": scaffold.mcp_json,
            "codexConfigToml": scaffold.codex_config_toml,
            "createdAgentCursors": created_agent_cursors,
        }));
    }

    println!(
        "\nWorkspace initialized. {} document(s) found.",
        md_files.len()
    );
    println!("Run `margent doctor` to verify provider auth and MCP readiness.");
    println!();
    println!("Claude Code MCP registration (.mcp.json):");
    println!("{}", scaffold.mcp_json);
    println!("Codex MCP registration (.codex/config.toml):");
    println!("{}", scaffold.codex_config_toml);
    if !write_config {
        println!("Run `margent init --write-config` to write those local registration files.");
    }
    Ok(())
}

fn write_agent_package(root: &Path, write_config: bool) -> Result<InitScaffoldSummary, String> {
    let mut created_files = Vec::new();
    let mut existing_files = Vec::new();
    let (mcp_json, codex_config_toml) = registration_snippets(root)?;

    write_file_if_missing(
        root,
        ".mdreview/skills/margent/SKILL.md",
        &margent_skill_template(),
        &mut created_files,
        &mut existing_files,
    )?;
    write_file_if_missing(
        root,
        ".mdreview/skills/margent/agents/openai.yaml",
        MARGENT_OPENAI_METADATA,
        &mut created_files,
        &mut existing_files,
    )?;
    write_file_if_missing(
        root,
        ".mdreview/manual.md",
        &manual_template(),
        &mut created_files,
        &mut existing_files,
    )?;
    write_file_if_missing(
        root,
        ".mdreview/skills/developmental-edit.md",
        &developmental_edit_pass_template(),
        &mut created_files,
        &mut existing_files,
    )?;
    write_file_if_missing(
        root,
        ".mdreview/skills/fact-check.md",
        &fact_check_pass_template(),
        &mut created_files,
        &mut existing_files,
    )?;
    write_file_if_missing(
        root,
        ".mdreview/skills/voice.md",
        &voice_pass_template(),
        &mut created_files,
        &mut existing_files,
    )?;
    write_file_if_missing(
        root,
        "AGENTS.md",
        &workspace_agents_template(),
        &mut created_files,
        &mut existing_files,
    )?;
    write_file_if_missing(
        root,
        "CLAUDE.md",
        &workspace_claude_template(),
        &mut created_files,
        &mut existing_files,
    )?;

    if write_config {
        write_file_if_missing(
            root,
            ".mcp.json",
            &mcp_json,
            &mut created_files,
            &mut existing_files,
        )?;
        write_file_if_missing(
            root,
            ".codex/config.toml",
            &codex_config_toml,
            &mut created_files,
            &mut existing_files,
        )?;
    }

    Ok(InitScaffoldSummary {
        created_files,
        existing_files,
        mcp_json,
        codex_config_toml,
    })
}

fn write_file_if_missing(
    root: &Path,
    relative_path: &str,
    body: &str,
    created_files: &mut Vec<String>,
    existing_files: &mut Vec<String>,
) -> Result<(), String> {
    let path = root.join(relative_path);
    if path.exists() {
        existing_files.push(relative_path.to_string());
        return Ok(());
    }
    workspace::write_string_atomic(&path, body)?;
    created_files.push(relative_path.to_string());
    Ok(())
}

fn registration_snippets(root: &Path) -> Result<(String, String), String> {
    let workspace_root = root.to_string_lossy().to_string();
    let mcp_json = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "margent": {
                "command": "margent",
                "args": ["mcp", "--workspace", workspace_root]
            }
        }
    }))
    .map_err(|error| format!("Unable to build MCP JSON snippet: {error}"))?;
    let codex_config_toml = format!(
        "[mcp_servers.margent]\ncommand = \"margent\"\nargs = [\"mcp\", \"--workspace\", {}]\n",
        toml_quote(&root.to_string_lossy())
    );
    Ok((format!("{mcp_json}\n"), codex_config_toml))
}

fn toml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

const MARGENT_SKILL_TEMPLATE: &str = include_str!("../../skills/margent/SKILL.md");
const MARGENT_SKILL_README: &str = include_str!("../../skills/margent/README.md");
const MARGENT_OPENAI_METADATA: &str = include_str!("../../skills/margent/agents/openai.yaml");

fn margent_skill_template() -> String {
    MARGENT_SKILL_TEMPLATE.to_string()
}

fn workspace_agents_template() -> String {
    r#"# AGENTS.md

This workspace uses Margent for Markdown review. Review state is local-first and lives in `.mdreview/`.

## Margent Rules

- Use `margent --json` or the Margent MCP server for review operations.
- Reply in existing threads when possible; create anchored threads for new comments.
- Read `.mdreview/manual.md` before reviewing; it is standing context for this workspace.
- Use `.mdreview/skills/*.md` review passes through `--pass <name>` when the user asks for a specific kind of review.
- Treat `.mdreview/memory.md` as accumulated review memory; it is human-editable and may be refreshed with `margent codify`.
- Never silently edit a reviewed Markdown document. Use proposals for changes that need human approval.
- After creating or editing a Markdown file the user should review, run `margent open <path>` so it opens in Margent. If targeting an existing review thread, run `margent open <path> --thread <thread_id>`.
- Destructive operations require explicit confirmation (`--yes` in CLI, `confirm: true` in MCP).
- After external Markdown edits, run `margent reanchor --check --document <relative-path>`.

## Useful Commands

- `margent files list --json`
- `margent open <doc> [--thread <thread_id>]`
- `margent threads list --document <path> --json`
- `margent threads show --id <thread_id> --json`
- `margent threads reply --id <thread_id> --body <text> --json`
- `margent proposals list --status pending --json`
- `margent proposals accept <proposal_id> --json`
- `margent export-critic <doc> --json`
- `margent import-critic <critic-file> --document <doc> --json`
- `margent codify --json`
- `margent codex feedback --id <thread_id> --pass voice --json`
- `margent claude revise --id <thread_id> --pass fact-check --json`
- `margent events tail --json --since <event_id>`
- `margent doctor --json`

## Sidecar Shape

- `.mdreview/documents/*.json`: indexed Markdown files, content hashes, heading indexes.
- `.mdreview/threads/*.json`: anchored review threads and messages.
- `.mdreview/proposals/*.json`: pending, accepted, rejected, stale, or failed revision proposals.
- `.mdreview/events.ndjson`: append-only workspace event log for agent cursors.
- `.mdreview/agents/*.json`: per-agent cursor state.
- `.mdreview/authorship/*.json`: accepted proposal spans with agent/provider provenance.
- `.mdreview/snapshots/*.json`: document snapshots for `margent revert-last`.
- `.mdreview/manual.md`: standing review instructions.
- `.mdreview/memory.md`: distilled review memory, generated by `margent codify` and safe to edit.
- `.mdreview/skills/*.md`: selectable review passes; `.mdreview/skills/margent/` is the agent skill package.
"#
    .to_string()
}

fn workspace_claude_template() -> String {
    r#"# CLAUDE.md

This workspace uses Margent for Markdown review. Review state is local-first and lives in `.mdreview/`.

## Claude Code Rules

- Use `margent --json` or the Margent MCP server for review operations.
- Prefer `margent claude ...` when asking Claude Code to answer comments or propose revisions.
- Use `margent codex ...` only if the user explicitly asks to route a review through Codex.
- Reply in existing threads when possible; create anchored threads for new comments.
- Read `.mdreview/manual.md` before reviewing; it is standing context for this workspace.
- Use `.mdreview/skills/*.md` review passes through `--pass <name>` when the user asks for a specific kind of review.
- Treat `.mdreview/memory.md` as accumulated review memory; it is human-editable and may be refreshed with `margent codify`.
- Never silently edit a reviewed Markdown document. Use proposals for changes that need human approval.
- After creating or editing a Markdown file the user should review, run `margent open <path>` so it opens in Margent. If targeting an existing review thread, run `margent open <path> --thread <thread_id>`.
- Destructive operations require explicit confirmation (`--yes` in CLI, `confirm: true` in MCP).
- After external Markdown edits, run `margent reanchor --check --document <relative-path>`.
- Do not ask for API keys, OAuth tokens, Keychain values, or provider secrets. Claude authentication belongs to Claude Code through `claude auth login`.

## Useful Commands

- `margent doctor --json`
- `margent files list --json`
- `margent open <doc> [--thread <thread_id>]`
- `margent threads list --document <path> --json`
- `margent threads show --id <thread_id> --json`
- `margent threads reply --id <thread_id> --body <text> --json`
- `margent claude feedback --id <thread_id> --pass voice --json`
- `margent claude revise --id <thread_id> --pass fact-check --json`
- `margent proposals list --status pending --json`
- `margent proposals accept <proposal_id> --json`
- `margent export <doc> --format docx --output <docx-path> --json`
- `margent reanchor --check --document <relative-path>`
- `margent codify --json`
- `margent events tail --json --since <event_id>`

## MCP

If this workspace is not already registered with Claude Code, run:

```sh
claude mcp add margent -- margent mcp --workspace <workspace-root>
```

`margent init --write-config` also writes `.mcp.json` for Claude Code-compatible MCP configuration.

## Sidecar Shape

- `.mdreview/documents/*.json`: indexed Markdown files, content hashes, heading indexes.
- `.mdreview/threads/*.json`: anchored review threads and messages.
- `.mdreview/proposals/*.json`: pending, accepted, rejected, stale, or failed revision proposals.
- `.mdreview/events.ndjson`: append-only workspace event log for agent cursors.
- `.mdreview/agents/*.json`: per-agent cursor state.
- `.mdreview/authorship/*.json`: accepted proposal spans with agent/provider provenance.
- `.mdreview/snapshots/*.json`: document snapshots for `margent revert-last`.
- `.mdreview/manual.md`: standing review instructions.
- `.mdreview/memory.md`: distilled review memory, generated by `margent codify` and safe to edit.
- `.mdreview/skills/*.md`: selectable review passes; `.mdreview/skills/margent/` is the agent skill package.
"#
    .to_string()
}

fn manual_template() -> String {
    r#"# Margent Workspace Manual

Write standing review instructions for this workspace here. Provider actions prepend this file to feedback, revise, and sync prompts.

Suggested topics:

- Target audience and publication context.
- Voice, style, and terminology preferences.
- Claims, citations, or facts that need special care.
- Revision boundaries agents should respect.
"#
    .to_string()
}

fn developmental_edit_pass_template() -> String {
    r#"# Developmental Edit

Focus on structure, argument, reader movement, missing context, and high-leverage revision opportunities. Prioritize the changes that most improve the document's purpose before line-level polish.
"#
    .to_string()
}

fn fact_check_pass_template() -> String {
    r#"# Fact Check

Check factual claims, names, dates, quotations, causal claims, and citation needs. Flag uncertainty explicitly and avoid inventing supporting evidence.
"#
    .to_string()
}

fn voice_pass_template() -> String {
    r#"# Voice

Preserve the author's voice. Suggest changes that sharpen rhythm, clarity, and emphasis without flattening distinctive phrasing or replacing the author with generic polished prose.
"#
    .to_string()
}

// ── doctor ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct WorkspaceDoctorSnapshot {
    documents: usize,
    threads: usize,
    open_threads: usize,
    proposals: usize,
    pending_proposals: usize,
    layout_errors: Vec<String>,
    warnings: Vec<String>,
}

fn cmd_doctor(output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let mut failures = Vec::new();
    let mut warnings = Vec::new();

    if !output.is_json() {
        println!("Margent doctor\n");
    }
    match env::current_exe() {
        Ok(exe) => {
            if !output.is_json() {
                println!("[ok] Running binary: {}", exe.display());
            }
        }
        Err(error) => warnings.push(format!("Unable to determine current binary: {error}")),
    }
    match resolve_executable("margent") {
        Some(path) => {
            if !output.is_json() {
                println!("[ok] margent is on PATH: {}", path.display());
            }
        }
        None => warnings
            .push("margent is not on PATH; run `margent install` for shell guidance.".into()),
    }

    let root = match workspace::find_workspace_root(&cwd) {
        Ok(root) => {
            if !output.is_json() {
                println!("[ok] Workspace root: {}", root.display());
            }
            Some(root)
        }
        Err(error) => {
            if error.contains("margent init") {
                failures.push(error);
            } else {
                failures.push(format!(
                    "{error} Run `margent init` from the workspace root."
                ));
            }
            None
        }
    };

    if let Some(root) = root.as_deref() {
        let snapshot = inspect_workspace_for_doctor(root);
        if snapshot.layout_errors.is_empty() {
            if !output.is_json() {
                println!("[ok] .mdreview/ layout is complete");
                println!("\nWorkspace stats:");
                println!("  Documents:  {}", snapshot.documents);
                println!(
                    "  Threads:    {} ({} open)",
                    snapshot.threads, snapshot.open_threads
                );
                println!(
                    "  Proposals:  {} ({} pending)",
                    snapshot.proposals, snapshot.pending_proposals
                );
            }

            match mcp::smoke_test(root) {
                Ok(tool_count) => {
                    if !output.is_json() {
                        println!("[ok] MCP server smoke test passed ({tool_count} tools)");
                        print_mcp_registration_hint(root);
                    }
                }
                Err(error) => {
                    failures.push(format!("MCP server smoke test failed: {error}"));
                }
            }
        } else {
            failures.extend(snapshot.layout_errors);
        }
        warnings.extend(snapshot.warnings);
    }

    let providers = inspect_providers();
    if !output.is_json() {
        println!("\nProviders:");
        print_provider_readiness(&providers);
    }
    warnings.extend(
        providers
            .iter()
            .filter_map(|provider| provider.next_step.clone()),
    );

    if !warnings.is_empty() && !output.is_json() {
        println!("\nWarnings:");
        for warning in &warnings {
            println!("  [warn] {warning}");
        }
    }
    if output.is_json() {
        print_json(&json!({
            "ok": failures.is_empty(),
            "warnings": &warnings,
            "failures": &failures,
            "providers": &providers,
        }))?;
        if !failures.is_empty() {
            return Err(format!(
                "Doctor found {} blocking issue(s).",
                failures.len()
            ));
        }
        return Ok(());
    }

    if !failures.is_empty() {
        println!("\nFailures:");
        for failure in &failures {
            println!("  [fail] {failure}");
        }
        return Err(format!(
            "Doctor found {} blocking issue(s).",
            failures.len()
        ));
    }

    println!("\nDoctor passed.");
    Ok(())
}

fn inspect_workspace_for_doctor(root: &Path) -> WorkspaceDoctorSnapshot {
    let mut snapshot = WorkspaceDoctorSnapshot::default();
    let mdreview = root.join(".mdreview");
    for subdir in [
        "documents",
        "threads",
        "proposals",
        "agents",
        "snapshots",
        "authorship",
    ] {
        if !mdreview.join(subdir).is_dir() {
            snapshot
                .layout_errors
                .push(format!("Missing .mdreview/{subdir}/. Run `margent init`."));
        }
    }
    for file in ["adapters.json", "events.ndjson"] {
        if !mdreview.join(file).is_file() {
            snapshot
                .layout_errors
                .push(format!("Missing .mdreview/{file}. Run `margent init`."));
        }
    }
    if !snapshot.layout_errors.is_empty() {
        return snapshot;
    }

    match workspace::load_all_documents(root) {
        Ok(documents) => {
            snapshot.documents = documents.len();
            let mut missing_files = 0;
            let mut stale_records = 0;
            for document in &documents {
                let abs = root.join(&document.relative_path);
                match fs::read_to_string(&abs) {
                    Ok(content) => {
                        if workspace::content_hash(&content) != document.current_content_hash {
                            stale_records += 1;
                        }
                    }
                    Err(_) => missing_files += 1,
                }
            }
            if missing_files > 0 {
                snapshot.warnings.push(format!(
                    "{missing_files} indexed document record(s) point to missing files."
                ));
            }
            if stale_records > 0 {
                snapshot.warnings.push(format!(
                    "{stale_records} indexed document record(s) have stale content hashes."
                ));
            }
        }
        Err(error) => snapshot
            .layout_errors
            .push(format!("Unable to load document records: {error}")),
    }

    match workspace::load_all_threads_sorted(root) {
        Ok(threads) => {
            snapshot.threads = threads.len();
            snapshot.open_threads = threads
                .iter()
                .filter(|thread| thread.status == "open")
                .count();
        }
        Err(error) => snapshot
            .layout_errors
            .push(format!("Unable to load thread records: {error}")),
    }

    match workspace::load_all_proposals(root) {
        Ok(proposals) => {
            snapshot.proposals = proposals.len();
            snapshot.pending_proposals = proposals
                .iter()
                .filter(|proposal| proposal.status == "pending")
                .count();
        }
        Err(error) => snapshot
            .layout_errors
            .push(format!("Unable to load proposal records: {error}")),
    }

    for agent_id in ["codex", "claude"] {
        if !mdreview
            .join("agents")
            .join(format!("{agent_id}.json"))
            .is_file()
        {
            snapshot.warnings.push(format!(
                "Missing {agent_id} agent cursor; run `margent init`."
            ));
        }
    }
    if !mdreview
        .join("skills")
        .join("margent")
        .join("SKILL.md")
        .is_file()
    {
        snapshot.warnings.push(
            "Missing .mdreview/skills/margent/SKILL.md; run `margent init` to scaffold the shared agent skill."
                .into(),
        );
    }
    if !root.join("AGENTS.md").is_file() {
        snapshot.warnings.push(
            "Missing workspace AGENTS.md; run `margent init` to scaffold agent instructions."
                .into(),
        );
    }
    if !root.join("CLAUDE.md").is_file() {
        snapshot.warnings.push(
            "Missing workspace CLAUDE.md; run `margent init` so Claude Code gets workspace instructions."
                .into(),
        );
    }
    if !root.join(".mcp.json").is_file() {
        snapshot.warnings.push(
            "Missing workspace .mcp.json; run `margent init --write-config` or `claude mcp add margent -- margent mcp --workspace <workspace-root>`."
                .into(),
        );
    }
    match claude_skill_path() {
        Some(path) if path.is_file() => {}
        Some(_) => snapshot.warnings.push(
            "Missing Claude Code Margent skill at ~/.claude/skills/margent/SKILL.md; run `margent install --agent-skills`."
                .into(),
        ),
        None => snapshot.warnings.push(
            "Unable to determine HOME for Claude Code skill check; run `margent install --agent-skills` if the skill is missing."
                .into(),
        ),
    }

    snapshot
}

fn claude_skill_path() -> Option<PathBuf> {
    env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".claude")
            .join("skills")
            .join("margent")
            .join("SKILL.md")
    })
}

fn print_mcp_registration_hint(root: &Path) {
    let binary = env::current_exe()
        .ok()
        .or_else(|| resolve_executable("margent"))
        .map(|path| shell_quote_path(&path))
        .unwrap_or_else(|| "margent".into());
    let workspace = shell_quote_path(root);
    println!("\nMCP registration:");
    println!("  Claude Code: claude mcp add margent -- {binary} mcp --workspace {workspace}");
    println!("  Codex config command: {binary} mcp --workspace {workspace}");
}

fn cmd_migrate(output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;
    let (total, migrated) = workspace::migrate_legacy_thread_records(&root)?;

    if output.is_json() {
        return print_json(&json!({
            "workspaceRoot": root,
            "threadsScanned": total,
            "threadsMigrated": migrated,
            "scope": "schema version + missing anchor kind normalization only",
        }));
    }

    println!("Workspace: {}", root.display());
    println!("Threads scanned: {total}");
    println!("Threads migrated: {migrated}");
    println!("Migration scope: schema version + missing anchor kind normalization only.");

    Ok(())
}

fn cmd_proposals(action: ProposalsAction, output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;

    match action {
        ProposalsAction::List { document, status } => {
            let document_record = document
                .as_deref()
                .map(|relative_path| workspace::resolve_document(&root, Some(relative_path)))
                .transpose()?;
            let mut proposals = workspace::load_all_proposals(&root)?;

            if let Some(document_record) = document_record.as_ref() {
                proposals.retain(|proposal| proposal.document_id == document_record.id);
            }
            if let Some(status) = status.as_deref() {
                proposals.retain(|proposal| proposal.status == status);
            }
            proposals.sort_by(|left, right| right.created_at.cmp(&left.created_at));

            if output.is_json() {
                return print_json(&json!({
                    "document": document_record,
                    "status": status,
                    "proposals": proposals,
                    "count": proposals.len(),
                }));
            }

            match document_record.as_ref() {
                Some(document) => {
                    println!(
                        "Proposals for \"{}\" ({})\n",
                        document.display_name, document.relative_path
                    );
                }
                None => println!("Proposals\n"),
            }
            if let Some(status) = status.as_deref() {
                println!("Status filter: {status}\n");
            }
            if proposals.is_empty() {
                println!("  No proposals found.");
                return Ok(());
            }
            for proposal in &proposals {
                println!(
                    "  [{}] {} :: {} ({})",
                    proposal.status, proposal.id, proposal.summary, proposal.adapter_id
                );
                println!(
                    "      document={} created={}",
                    proposal.document_id, proposal.created_at
                );
            }
            println!("\n  {} proposal(s) total.", proposals.len());
            Ok(())
        }
        ProposalsAction::Show { id } => {
            let proposal = workspace::load_proposal(&root, &id)?;
            let document = workspace::load_document_by_id(&root, &proposal.document_id).ok();

            if output.is_json() {
                return print_json(&json!({
                    "document": document,
                    "proposal": proposal,
                }));
            }

            println!("Proposal {}", proposal.id);
            println!("  Status:   {}", proposal.status);
            println!("  Adapter:  {}", proposal.adapter_id);
            println!("  Created:  {}", proposal.created_at);
            println!("  Updated:  {}", proposal.updated_at);
            if let Some(document) = document.as_ref() {
                println!(
                    "  Document: {} ({})",
                    document.display_name, document.relative_path
                );
            } else {
                println!("  Document: {}", proposal.document_id);
            }
            println!("  Threads:  {}", proposal.thread_ids.join(", "));
            println!();
            println!("Summary:");
            println!("{}", proposal.summary);
            println!();
            println!("Assistant message:");
            println!("{}", proposal.assistant_message);
            if !proposal.computed_diff.trim().is_empty() {
                println!();
                println!("Diff:");
                println!("{}", proposal.computed_diff);
            }
            if !proposal.warnings.is_empty() {
                println!();
                println!("Warnings:");
                for warning in &proposal.warnings {
                    println!("  - {warning}");
                }
            }
            Ok(())
        }
        ProposalsAction::Accept { id } => {
            let result = workspace::accept_proposal(&root, &id, None)?;
            if output.is_json() {
                return print_json(&result);
            }

            println!("Proposal {} accepted.", result.proposal.id);
            if let Some(document) = result.document.as_ref() {
                println!("Applied to {}.", document.relative_path);
            }
            if let Some(snapshot) = result.snapshot.as_ref() {
                println!("Snapshot saved: {}", snapshot.id);
                println!(
                    "Revert with: margent revert-last --document {}",
                    snapshot.relative_path
                );
            }
            Ok(())
        }
        ProposalsAction::Reject { id } => {
            let result = workspace::reject_proposal(&root, &id)?;
            if output.is_json() {
                return print_json(&result);
            }

            println!("Proposal {} rejected.", result.proposal.id);
            Ok(())
        }
    }
}

fn cmd_files(action: FilesAction, output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;

    match action {
        FilesAction::List => {
            let mut documents = workspace::load_all_documents(&root)?;
            documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
            if output.is_json() {
                return print_json(&json!({
                    "workspaceRoot": root,
                    "documents": documents,
                    "count": documents.len(),
                }));
            }

            if documents.is_empty() {
                println!("No indexed Markdown files found.");
                return Ok(());
            }
            for document in &documents {
                println!(
                    "{}  {} words  {}",
                    document.relative_path, document.word_count, document.current_content_hash
                );
            }
            Ok(())
        }
        FilesAction::Read { document } => {
            let document_record = workspace::resolve_document(&root, Some(&document))?;
            let content = workspace::read_document_content(&root, &document_record.relative_path)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": document_record,
                    "content": content,
                }));
            }

            print!("{content}");
            Ok(())
        }
        FilesAction::Create { document, content } => {
            let document_record = workspace::create_markdown_file(&root, &document, &content)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": document_record,
                    "action": "created",
                }));
            }

            println!("Created {}.", document_record.relative_path);
            Ok(())
        }
        FilesAction::Rename { from, to } => {
            let document_record = workspace::rename_markdown_file(&root, &from, &to)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": document_record,
                    "from": from,
                    "action": "renamed",
                }));
            }

            println!("Renamed {from} -> {}.", document_record.relative_path);
            Ok(())
        }
        FilesAction::Delete { document, yes } => {
            if !yes {
                return Err(
                    "Pass --yes to confirm deleting this document and its sidecars.".into(),
                );
            }
            let document_record = workspace::delete_markdown_file(&root, &document)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": document_record,
                    "action": "deleted",
                }));
            }

            println!("Deleted {}.", document_record.relative_path);
            println!("A snapshot was saved; use `margent revert-last` to restore it.");
            Ok(())
        }
        FilesAction::Outline { document } => {
            let document_record = workspace::resolve_document(&root, Some(&document))?;
            let content = workspace::read_document_content(&root, &document_record.relative_path)?;
            let heading_index = workspace::extract_heading_index(&content);
            if output.is_json() {
                return print_json(&json!({
                    "document": document_record,
                    "headingIndex": heading_index,
                }));
            }

            if heading_index.is_empty() {
                println!("No headings found in {}.", document_record.relative_path);
                return Ok(());
            }
            for heading in heading_index {
                println!(
                    "{}:{} {}",
                    "#".repeat(heading.depth as usize),
                    heading.line,
                    heading.text
                );
            }
            Ok(())
        }
    }
}

fn cmd_export(
    document: &str,
    format: Option<export::ExportFormat>,
    gdoc: bool,
    output_path: Option<&Path>,
    output: OutputFormat,
) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;
    let document_record = workspace::resolve_document(&root, Some(document))?;
    let content = workspace::read_document_content(&root, &document_record.relative_path)?;

    if gdoc {
        let result =
            export::export_google_doc(&root, &document_record, &content, format, output_path)?;
        if output.is_json() {
            return print_json(&json!({
                "document": document_record,
                "googleDoc": result,
                "action": "googleDocExported",
            }));
        }

        println!(
            "Exported {} to Google Docs via {}.",
            document_record.relative_path,
            result.source_format.label()
        );
        println!("Google Doc: {}", result.url);
        if let Some(path) = result.intermediate_path.as_ref() {
            println!("Intermediate file: {}", path.display());
        }
        return Ok(());
    }

    let format = format
        .or_else(|| output_path.and_then(export::format_from_path))
        .unwrap_or(export::ExportFormat::Html);
    let result = export::export_file(&root, &document_record, &content, format, output_path)?;
    if output.is_json() {
        return print_json(&json!({
            "document": document_record,
            "export": result,
            "action": "exported",
        }));
    }

    println!(
        "Exported {} as {}.",
        document_record.relative_path,
        result.format.label()
    );
    println!("Output: {}", result.output_path.display());
    Ok(())
}

fn cmd_export_critic(
    document: &str,
    output_path: Option<&Path>,
    include_resolved: bool,
    output: OutputFormat,
) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;
    let result = critic::export_critic(&root, document, output_path, include_resolved)?;

    if output.is_json() {
        return print_json(&json!({
            "export": result,
            "action": "criticMarkupExported",
        }));
    }

    println!(
        "Exported {} to CriticMarkup copy.",
        result.document.relative_path
    );
    println!("Output: {}", result.output_path);
    print_warnings(&result.warnings);
    Ok(())
}

fn cmd_import_critic(
    critic_file: &Path,
    document: &str,
    dry_run: bool,
    author_name: &str,
    output: OutputFormat,
) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;
    let result = critic::import_critic(&root, critic_file, document, dry_run, author_name)?;

    if output.is_json() {
        return print_json(&json!({
            "import": result,
            "action": if dry_run {
                "criticMarkupImportPlanned"
            } else {
                "criticMarkupImported"
            },
        }));
    }

    if dry_run {
        println!(
            "Would import {} thread(s) and {} proposal(s) for {}.",
            result.imported_threads, result.imported_proposals, result.document.relative_path
        );
    } else {
        println!(
            "Imported {} thread(s) and {} proposal(s) for {}.",
            result.imported_threads, result.imported_proposals, result.document.relative_path
        );
    }
    if !result.thread_ids.is_empty() {
        println!("Threads: {}", result.thread_ids.join(", "));
    }
    if !result.proposal_ids.is_empty() {
        println!("Proposals: {}", result.proposal_ids.join(", "));
    }
    print_warnings(&result.warnings);
    Ok(())
}

fn print_warnings(warnings: &[String]) {
    if warnings.is_empty() {
        return;
    }
    println!("Warnings:");
    for warning in warnings {
        println!("  - {warning}");
    }
}

fn cmd_revert_last(document: Option<&str>, output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;
    let (snapshot, document) = workspace::revert_latest_snapshot(&root, document)?;

    if output.is_json() {
        return print_json(&json!({
            "snapshot": snapshot,
            "document": document,
            "action": "reverted",
        }));
    }

    println!(
        "Restored {} from snapshot {}.",
        document.relative_path, snapshot.id
    );
    Ok(())
}

fn cmd_events(action: EventsAction, output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;

    match action {
        EventsAction::Tail { follow, since } => {
            let mut last_seen_event_id = since.clone();
            let events = filter_events_since(workspace::load_events(&root)?, since.as_deref())?;
            for event in &events {
                print_event(event, output)?;
                last_seen_event_id = Some(event.id.clone());
            }
            std::io::stdout()
                .flush()
                .map_err(|error| format!("Unable to flush event output: {error}"))?;

            if !follow {
                return Ok(());
            }

            let event_path = workspace::ensure_workspace_layout(&root)?.join("events.ndjson");
            let watch_path = event_path
                .parent()
                .ok_or_else(|| "Unable to derive events directory.".to_string())?
                .to_path_buf();
            let (tx, rx) = mpsc::channel();
            let mut watcher = RecommendedWatcher::new(
                move |result| {
                    let _ = tx.send(result);
                },
                NotifyConfig::default(),
            )
            .map_err(|error| format!("Unable to create event watcher: {error}"))?;
            watcher
                .watch(&watch_path, RecursiveMode::NonRecursive)
                .map_err(|error| format!("Unable to watch {}: {error}", watch_path.display()))?;

            loop {
                match rx.recv() {
                    Ok(Ok(event)) => {
                        if !event.paths.iter().any(|path| path == &event_path) {
                            continue;
                        }
                        let next_events = filter_events_since(
                            workspace::load_events(&root)?,
                            last_seen_event_id.as_deref(),
                        )?;
                        for event in &next_events {
                            print_event(event, output)?;
                            last_seen_event_id = Some(event.id.clone());
                        }
                        std::io::stdout()
                            .flush()
                            .map_err(|error| format!("Unable to flush event output: {error}"))?;
                    }
                    Ok(Err(error)) => return Err(format!("Event watcher failed: {error}")),
                    Err(error) => return Err(format!("Event watcher channel closed: {error}")),
                }
            }
        }
    }
}

fn filter_events_since(
    events: Vec<models::EventRecord>,
    since: Option<&str>,
) -> Result<Vec<models::EventRecord>, String> {
    let Some(since) = since else {
        return Ok(events);
    };
    let Some(index) = events.iter().position(|event| event.id == since) else {
        return Err(format!("Event {since} was not found in this workspace."));
    };
    Ok(events.into_iter().skip(index + 1).collect())
}

fn print_event(event: &models::EventRecord, output: OutputFormat) -> Result<(), String> {
    if output.is_json() {
        let line = serde_json::to_string(event)
            .map_err(|error| format!("Unable to serialize event: {error}"))?;
        println!("{line}");
        return Ok(());
    }

    println!(
        "{} {} thread={} document={} proposal={}",
        event.timestamp,
        event.event_type,
        event.thread_id.as_deref().unwrap_or("-"),
        event.document_id.as_deref().unwrap_or("-"),
        event.proposal_id.as_deref().unwrap_or("-"),
    );
    if let Some(body) = event.body.as_deref().filter(|body| !body.trim().is_empty()) {
        println!("  {}", truncate(body, 100));
    }
    Ok(())
}

#[derive(Debug, Default)]
struct ReanchorStats {
    blocking_open_threads: usize,
    changed_threads: usize,
    detached_threads: usize,
    documents: usize,
    needs_review_threads: usize,
    reports: Vec<ReanchorThreadReport>,
    threads: usize,
}

#[derive(Debug, Serialize)]
struct ReanchorThreadReport {
    changed: bool,
    confidence: f32,
    document_path: String,
    state: String,
    status: String,
    thread_id: String,
    title: String,
}

fn cmd_reanchor(
    document: Option<&str>,
    check: bool,
    dry_run: bool,
    output: OutputFormat,
) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;
    let stats = reanchor_workspace(&root, document, dry_run)?;

    if output.is_json() {
        let blocking_open_threads = stats.blocking_open_threads;
        print_json(&json!({
            "workspaceRoot": root,
            "documentFilter": document,
            "dryRun": dry_run,
            "documentsScanned": stats.documents,
            "threadsScanned": stats.threads,
            "threadsChanged": stats.changed_threads,
            "needsReviewThreads": stats.needs_review_threads,
            "detachedThreads": stats.detached_threads,
            "blockingOpenThreads": stats.blocking_open_threads,
            "reports": stats.reports,
        }))?;
        if check && blocking_open_threads > 0 {
            return Err(format!(
                "{} open thread anchor(s) need review after reanchor.",
                blocking_open_threads
            ));
        }
        return Ok(());
    }

    println!("Workspace: {}", root.display());
    if let Some(document) = document {
        println!("Document filter: {document}");
    }
    println!(
        "Mode: {}",
        if dry_run { "dry run" } else { "write updates" }
    );
    println!("Documents scanned: {}", stats.documents);
    println!("Threads scanned: {}", stats.threads);
    println!("Threads changed: {}", stats.changed_threads);
    println!(
        "Anchors needing attention: {} needs_review, {} detached",
        stats.needs_review_threads, stats.detached_threads
    );

    let notable_reports: Vec<_> = stats
        .reports
        .iter()
        .filter(|report| {
            report.changed || matches!(report.state.as_str(), "detached" | "needs_review")
        })
        .collect();
    if !notable_reports.is_empty() {
        println!("\nThread anchor report:");
        for report in notable_reports {
            let marker = if report.changed { "updated" } else { "check" };
            println!(
                "  [{marker}] {} :: {} ({}, confidence {:.2})",
                report.document_path, report.title, report.state, report.confidence
            );
            println!("      id={} status={}", report.thread_id, report.status);
        }
    }

    if check && stats.blocking_open_threads > 0 {
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
        return Err(format!(
            "{} open thread anchor(s) need review after reanchor.",
            stats.blocking_open_threads
        ));
    }

    Ok(())
}

fn reanchor_workspace(
    root: &Path,
    document: Option<&str>,
    dry_run: bool,
) -> Result<ReanchorStats, String> {
    let mut documents = if let Some(relative_path) = document {
        vec![workspace::resolve_document(root, Some(relative_path))?]
    } else {
        workspace::load_all_documents(root)?
    };
    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let mut stats = ReanchorStats {
        documents: documents.len(),
        ..ReanchorStats::default()
    };

    for doc in documents {
        let content = workspace::read_document_content(root, &doc.relative_path)?;
        let content_hash = workspace::content_hash(&content);
        let heading_index = workspace::extract_heading_index(&content);
        let threads = workspace::load_threads_sorted(root, &doc.id)?;
        for mut thread in threads {
            stats.threads += 1;
            let previous_anchor = thread.anchor.clone();
            let changed =
                anchor_service::reattach_anchor(&mut thread.anchor, &content, &heading_index);
            let reanchor_hash_changed =
                thread.last_reanchor_content_hash.as_deref() != Some(content_hash.as_str());

            if changed || reanchor_hash_changed {
                stats.changed_threads += 1;
                if !dry_run {
                    if thread.created_content_hash.is_none() {
                        thread.created_content_hash =
                            Some(previous_anchor.base_content_hash.clone());
                    }
                    thread.last_reanchor_content_hash = Some(content_hash.clone());
                    thread.updated_at = workspace::now_rfc3339()?;
                    workspace::save_thread(root, &thread)?;
                }
            }

            match thread.anchor.state.as_str() {
                "detached" => stats.detached_threads += 1,
                "needs_review" => stats.needs_review_threads += 1,
                _ => {}
            }
            if thread.status == "open"
                && matches!(thread.anchor.state.as_str(), "detached" | "needs_review")
            {
                stats.blocking_open_threads += 1;
            }

            stats.reports.push(ReanchorThreadReport {
                changed: changed || thread.anchor != previous_anchor,
                confidence: thread.anchor.confidence,
                document_path: doc.relative_path.clone(),
                state: thread.anchor.state.clone(),
                status: thread.status.clone(),
                thread_id: thread.id.clone(),
                title: thread.title.clone(),
            });
        }
    }

    Ok(stats)
}

fn print_provider_readiness(providers: &[margent_core::provider_readiness::ProviderReadiness]) {
    for provider in providers {
        match provider.status {
            ProviderReadinessStatus::Ready => {
                let path = provider
                    .binary_path
                    .as_deref()
                    .unwrap_or(provider.binary_name.as_str());
                println!("[ok] {}: ready ({path})", provider.display_name);
            }
            ProviderReadinessStatus::Missing
            | ProviderReadinessStatus::Unauthenticated
            | ProviderReadinessStatus::AuthCheckFailed => {
                println!(
                    "[--] {}",
                    provider.next_step.as_deref().unwrap_or(
                        "Provider is not ready; install and authenticate the provider CLI."
                    )
                );
                if let Some(error) = provider.check_error.as_deref() {
                    println!("     detail: {error}");
                }
            }
        }
    }
}

fn resolve_executable(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn shell_quote_path(path: &Path) -> String {
    shell_quote(&path.to_string_lossy())
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | '+'))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

struct ThreadAuthor {
    created_by: &'static str,
    author_type: &'static str,
    author_name: &'static str,
    agent_id: Option<&'static str>,
}

fn thread_author(agent: Option<AgentIdentity>) -> ThreadAuthor {
    match agent {
        Some(identity) => ThreadAuthor {
            created_by: identity.id(),
            author_type: "agent",
            author_name: identity.author_name(),
            agent_id: Some(identity.id()),
        },
        None => ThreadAuthor {
            created_by: "user",
            author_type: "user",
            author_name: "You",
            agent_id: None,
        },
    }
}

fn refresh_thread_anchor_if_needed(
    root: &Path,
    content: &str,
    thread: &mut models::ThreadRecord,
) -> Result<(), String> {
    let heading_index = workspace::extract_heading_index(content);
    let changed = anchor_service::reattach_anchor(&mut thread.anchor, content, &heading_index);
    let content_hash = workspace::content_hash(content);
    let reanchor_hash_changed =
        thread.last_reanchor_content_hash.as_deref() != Some(content_hash.as_str());

    if changed || reanchor_hash_changed {
        if thread.created_content_hash.is_none() {
            thread.created_content_hash = Some(thread.anchor.base_content_hash.clone());
        }
        thread.last_reanchor_content_hash = Some(content_hash);
        thread.updated_at = workspace::now_rfc3339()?;
        workspace::save_thread(root, thread)?;
    }

    Ok(())
}

// ── threads ─────────────────────────────────────────────────────────────────

fn cmd_threads(action: ThreadsAction, output: OutputFormat) -> Result<(), String> {
    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;

    match action {
        ThreadsAction::List { document } => {
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let threads = workspace::load_threads_sorted(&root, &doc.id)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": doc,
                    "threads": threads.iter().map(|thread| thread_with_deep_link(&root, &doc.relative_path, thread)).collect::<Vec<_>>(),
                    "count": threads.len(),
                }));
            }

            println!(
                "Threads for \"{}\" ({})\n",
                doc.display_name, doc.relative_path
            );
            if threads.is_empty() {
                println!("  No threads found.");
                return Ok(());
            }

            for (i, thread) in threads.iter().enumerate() {
                let ordinal = i + 1;
                let msg_count = thread.messages.len();
                let status_icon = match thread.status.as_str() {
                    "open" => "o",
                    "resolved" => "x",
                    "archived" => "-",
                    _ => "?",
                };
                println!(
                    "  [{status_icon}] Thread {ordinal}: {} ({msg_count} message(s), {status})",
                    thread.title,
                    status = thread.status,
                );
                println!("      Anchor: \"{}\"", truncate(&thread.anchor.quote, 60));
                println!("      ID: {}", thread.id);
                println!(
                    "      Link: {}",
                    thread_deep_link(&root.to_string_lossy(), &doc.relative_path, &thread.id)
                );
            }

            println!("\n  {} thread(s) total.", threads.len());
            Ok(())
        }
        ThreadsAction::Show { thread, document } => {
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let (thread, target_label) =
                resolve_thread_selector(&root, &doc.id, thread.ordinal, thread.id.as_deref())?;

            if output.is_json() {
                return print_json(&json!({
                    "document": doc,
                    "targetLabel": target_label,
                    "thread": thread_with_deep_link(&root, &doc.relative_path, &thread),
                }));
            }

            println!("{target_label}: {}", thread.title);
            println!("  ID:      {}", thread.id);
            println!("  Status:  {}", thread.status);
            println!(
                "  Link:    {}",
                thread_deep_link(&root.to_string_lossy(), &doc.relative_path, &thread.id)
            );
            println!("  Created: {}", thread.created_at);
            println!("  Updated: {}", thread.updated_at);
            println!("  Document: {} ({})", doc.display_name, doc.id);
            println!();

            // Anchor
            println!("Anchor:");
            println!("  Quote:  \"{}\"", thread.anchor.quote);
            println!(
                "  Lines:  {}:{} - {}:{}",
                thread.anchor.start_line,
                thread.anchor.start_column,
                thread.anchor.end_line,
                thread.anchor.end_column
            );
            println!(
                "  State:  {} (confidence: {})",
                thread.anchor.state, thread.anchor.confidence
            );
            if !thread.anchor.heading_path.is_empty() {
                println!("  Heading: {}", thread.anchor.heading_path.join(" > "));
            }
            println!();

            // Messages
            println!("Messages ({}):", thread.messages.len());
            println!();
            for (i, msg) in thread.messages.iter().enumerate() {
                let role_tag = match msg.author_type.as_str() {
                    "agent" => format!(
                        "[{} via {}]",
                        msg.author_name,
                        msg.agent_id.as_deref().unwrap_or("?")
                    ),
                    "system" => "[system]".to_string(),
                    _ => format!("[{}]", msg.author_name),
                };
                println!("  {}. {} ({})", i + 1, role_tag, msg.kind);
                println!("     {}", msg.created_at);
                // Print body with indentation
                for line in msg.body.lines() {
                    println!("     {line}");
                }
                println!();
            }

            // Linked proposals
            if !thread.linked_proposal_ids.is_empty() {
                println!(
                    "Linked proposals: {}",
                    thread.linked_proposal_ids.join(", ")
                );
            }

            Ok(())
        }
        ThreadsAction::Add {
            quote,
            body,
            title,
            occurrence,
            document,
            agent,
        } => {
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let content = workspace::read_document_content(&root, &doc.relative_path)?;
            let anchor = workspace::build_anchor_from_quote(&doc, &content, &quote, occurrence)?;
            let author = thread_author(agent);
            let thread = workspace::create_thread(
                &root,
                &doc,
                title.as_deref().unwrap_or(""),
                &body,
                anchor,
                author.created_by,
                author.author_type,
                author.author_name,
                author.agent_id,
            )?;

            if output.is_json() {
                return print_json(&json!({
                    "document": doc,
                    "thread": thread_with_deep_link(&root, &doc.relative_path, &thread),
                    "action": "created",
                }));
            }

            println!(
                "Created thread {} for {} ({})",
                thread.id, doc.display_name, doc.relative_path
            );
            println!("  Title:  {}", thread.title);
            println!("  Quote:  \"{}\"", thread.anchor.quote);
            println!("  Status: {}", thread.status);
            println!(
                "  Link:   {}",
                thread_deep_link(&root.to_string_lossy(), &doc.relative_path, &thread.id)
            );
            Ok(())
        }
        ThreadsAction::Reply {
            thread,
            body,
            reply_to,
            kind,
            document,
            agent,
        } => {
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let (thread, target_label) =
                resolve_thread_selector(&root, &doc.id, thread.ordinal, thread.id.as_deref())?;
            let reply_to_message_id = match reply_to {
                Some(message_ordinal) => {
                    Some(workspace::resolve_message_by_ordinal(&thread, message_ordinal)?.id)
                }
                None => None,
            };

            let author = thread_author(agent);
            let updated = workspace::add_thread_message(
                &root,
                &thread.id,
                &body,
                &kind,
                author.author_type,
                author.author_name,
                author.agent_id,
                reply_to_message_id.as_deref(),
            )?;

            if output.is_json() {
                return print_json(&json!({
                    "document": doc,
                    "targetLabel": target_label,
                    "thread": updated,
                    "replyToMessageId": reply_to_message_id,
                    "action": "messageAdded",
                }));
            }

            println!("{target_label} -> {} \"{}\"", thread.id, thread.title);
            if let Some(reply_to_id) = reply_to_message_id.as_deref() {
                println!("Replying to message: {reply_to_id}");
            }
            println!("Reply saved to thread {}.", updated.id);
            Ok(())
        }
        ThreadsAction::Delete {
            thread,
            document,
            yes,
        } => {
            if !yes {
                return Err("Pass --yes to confirm deleting this thread.".into());
            }
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let (thread, target_label) =
                resolve_thread_selector(&root, &doc.id, thread.ordinal, thread.id.as_deref())?;

            let deleted = workspace::delete_thread(&root, &thread.id)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": doc,
                    "targetLabel": target_label,
                    "thread": deleted,
                    "action": "deleted",
                }));
            }

            println!("{target_label} -> {} \"{}\"", thread.id, thread.title);
            println!("Thread {} deleted.", thread.id);
            Ok(())
        }
        ThreadsAction::DeleteMessage {
            ordinal,
            message,
            document,
            yes,
        } => {
            if !yes {
                return Err("Pass --yes to confirm deleting this message.".into());
            }
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let thread = workspace::resolve_thread_by_ordinal(&root, &doc.id, ordinal)?;
            let message_record = workspace::resolve_message_by_ordinal(&thread, message)?;

            match workspace::delete_thread_message(&root, &thread.id, message)? {
                Some(updated_thread) => {
                    if output.is_json() {
                        return print_json(&json!({
                            "document": doc,
                            "thread": updated_thread,
                            "deletedMessage": message_record,
                            "deletedThread": false,
                            "action": "messageDeleted",
                        }));
                    }
                    println!("Thread {ordinal} -> {} \"{}\"", thread.id, thread.title);
                    println!("Deleting message {message} -> {}", message_record.id);
                    println!(
                        "Message deleted. Thread {} now has {} message(s).",
                        updated_thread.id,
                        updated_thread.messages.len()
                    );
                }
                None => {
                    if output.is_json() {
                        return print_json(&json!({
                            "document": doc,
                            "thread": thread,
                            "deletedMessage": message_record,
                            "deletedThread": true,
                            "action": "threadDeleted",
                        }));
                    }
                    println!("Thread {ordinal} -> {} \"{}\"", thread.id, thread.title);
                    println!("Deleting message {message} -> {}", message_record.id);
                    println!("That was the last message, so the thread was deleted.");
                }
            }

            Ok(())
        }
        ThreadsAction::Resolve { thread, document } => {
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let (thread, target_label) =
                resolve_thread_selector(&root, &doc.id, thread.ordinal, thread.id.as_deref())?;
            let resolved = workspace::resolve_thread(&root, &thread.id)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": doc,
                    "targetLabel": target_label,
                    "thread": resolved,
                    "action": "resolved",
                }));
            }

            println!("{target_label} -> {} \"{}\"", thread.id, thread.title);
            println!("Thread {} is now {}.", resolved.id, resolved.status);
            Ok(())
        }
        ThreadsAction::Reopen { thread, document } => {
            let doc = workspace::resolve_document(&root, document.as_deref())?;
            let (thread, target_label) =
                resolve_thread_selector(&root, &doc.id, thread.ordinal, thread.id.as_deref())?;
            let reopened = workspace::reopen_thread(&root, &thread.id)?;
            if output.is_json() {
                return print_json(&json!({
                    "document": doc,
                    "targetLabel": target_label,
                    "thread": reopened,
                    "action": "reopened",
                }));
            }

            println!("{target_label} -> {} \"{}\"", thread.id, thread.title);
            println!("Thread {} is now {}.", reopened.id, reopened.status);
            Ok(())
        }
    }
}

// ── provider commands ───────────────────────────────────────────────────────

fn cmd_provider(
    provider: Provider,
    action: ProviderAction,
    output: OutputFormat,
) -> Result<(), String> {
    // Check provider availability
    if !provider.is_available() {
        return Err(format!(
            "{} is not installed or not on PATH. Install it first.",
            provider.display_name()
        ));
    }

    let cwd =
        env::current_dir().map_err(|e| format!("Unable to determine current directory: {e}"))?;
    let root = workspace::find_workspace_root(&cwd)?;

    match action {
        ProviderAction::Comment {
            quote,
            body,
            title,
            occurrence,
            document,
        } => cmd_provider_comment(
            provider,
            &root,
            ProviderCommentRequest {
                quote: &quote,
                body: &body,
                title: title.as_deref(),
                occurrence,
                document: document.as_deref(),
                output,
            },
        ),

        ProviderAction::Reply {
            thread,
            body,
            reply_to,
            kind,
            document,
        } => cmd_provider_reply(
            provider,
            &root,
            thread.ordinal,
            thread.id.as_deref(),
            &body,
            reply_to,
            &kind,
            document.as_deref(),
            output,
        ),

        ProviderAction::Feedback {
            thread,
            instruction,
            pass,
            document,
            stream,
        } => cmd_feedback(
            provider,
            &root,
            thread.ordinal,
            thread.id.as_deref(),
            instruction.as_deref(),
            pass.as_deref(),
            document.as_deref(),
            stream,
            output,
        ),

        ProviderAction::Revise {
            thread,
            instruction,
            pass,
            document,
            apply,
            resolve,
            stream,
        } => cmd_revise(
            provider,
            &root,
            thread.ordinal,
            thread.id.as_deref(),
            instruction.as_deref(),
            pass.as_deref(),
            document.as_deref(),
            apply,
            resolve,
            stream,
            output,
        ),

        ProviderAction::Sync { pass } => cmd_sync(provider, &root, pass.as_deref(), output),
    }
}

struct ProviderCommentRequest<'a> {
    quote: &'a str,
    body: &'a str,
    title: Option<&'a str>,
    occurrence: usize,
    document: Option<&'a str>,
    output: OutputFormat,
}

fn cmd_provider_comment(
    prov: Provider,
    root: &Path,
    request: ProviderCommentRequest<'_>,
) -> Result<(), String> {
    let doc = workspace::resolve_document(root, request.document)?;
    let content = workspace::read_document_content(root, &doc.relative_path)?;
    let anchor =
        workspace::build_anchor_from_quote(&doc, &content, request.quote, request.occurrence)?;
    let author = thread_author(Some(match prov {
        Provider::Codex => AgentIdentity::Codex,
        Provider::Claude => AgentIdentity::Claude,
    }));
    let thread = workspace::create_thread(
        root,
        &doc,
        request.title.unwrap_or(""),
        request.body,
        anchor,
        author.created_by,
        author.author_type,
        author.author_name,
        author.agent_id,
    )?;

    if request.output.is_json() {
        return print_json(&json!({
            "provider": prov.id(),
            "document": doc,
            "thread": thread,
            "action": "created",
        }));
    }

    println!(
        "{} created thread {} for {} ({})",
        prov.display_name(),
        thread.id,
        doc.display_name,
        doc.relative_path
    );
    println!("  Title:  {}", thread.title);
    println!("  Quote:  \"{}\"", thread.anchor.quote);
    println!("  Status: {}", thread.status);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_provider_reply(
    prov: Provider,
    root: &Path,
    ordinal: Option<usize>,
    thread_id: Option<&str>,
    body: &str,
    reply_to: Option<usize>,
    kind: &str,
    document: Option<&str>,
    output: OutputFormat,
) -> Result<(), String> {
    let doc = workspace::resolve_document(root, document)?;
    let (thread, target_label) = resolve_thread_selector(root, &doc.id, ordinal, thread_id)?;
    let reply_to_message_id = match reply_to {
        Some(message_ordinal) => {
            Some(workspace::resolve_message_by_ordinal(&thread, message_ordinal)?.id)
        }
        None => None,
    };
    let author = thread_author(Some(match prov {
        Provider::Codex => AgentIdentity::Codex,
        Provider::Claude => AgentIdentity::Claude,
    }));

    let updated = workspace::add_thread_message(
        root,
        &thread.id,
        body,
        kind,
        author.author_type,
        author.author_name,
        author.agent_id,
        reply_to_message_id.as_deref(),
    )?;

    if output.is_json() {
        return print_json(&json!({
            "provider": prov.id(),
            "document": doc,
            "targetLabel": target_label,
            "thread": updated,
            "replyToMessageId": reply_to_message_id,
            "action": "messageAdded",
        }));
    }

    println!(
        "{} replying to {target_label} -> {} \"{}\"",
        prov.display_name(),
        thread.id,
        thread.title
    );
    if let Some(reply_to_id) = reply_to_message_id.as_deref() {
        println!("Replying to message: {reply_to_id}");
    }
    println!("Reply saved to thread {}.", updated.id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_feedback(
    prov: Provider,
    root: &Path,
    ordinal: Option<usize>,
    thread_id: Option<&str>,
    instruction: Option<&str>,
    pass_name: Option<&str>,
    document: Option<&str>,
    stream: bool,
    output: OutputFormat,
) -> Result<(), String> {
    let doc = workspace::resolve_document(root, document)?;
    let (mut thread, target_label) = resolve_thread_selector(root, &doc.id, ordinal, thread_id)?;

    if !output.is_json() {
        println!("{target_label} -> {} \"{}\"", thread.id, thread.title);
        println!("Provider: {} ({})", prov.display_name(), prov.id());
        print_review_context_selection(root, pass_name)?;
        println!();
    }

    let content = workspace::read_document_content(root, &doc.relative_path)?;
    refresh_thread_anchor_if_needed(root, &content, &mut thread)?;

    let prompt = if let Some(inst) = instruction {
        if !output.is_json() {
            println!("Instruction: {inst}");
            println!();
        }
        provider::build_feedback_prompt_with_instruction(
            &content,
            &doc.relative_path,
            &thread,
            inst,
        )
    } else {
        provider::build_feedback_prompt(&content, &doc.relative_path, &thread)
    };
    let prompt = prepend_review_context(root, pass_name, prompt)?;

    eprintln!("Calling {}...", prov.display_name());

    let response = execute_provider_for_thread(prov, root, &prompt, &mut thread, stream, output)?;
    if !response.success {
        let mut err = format!("{} returned a non-zero exit code.", prov.display_name());
        if !response.stderr.is_empty() {
            err.push_str(&format!("\nstderr: {}", response.stderr.trim()));
        }
        return Err(err);
    }

    let feedback = provider::parse_feedback_response(prov, &response)?;

    actions::write_feedback_reply(root, &mut thread, prov, &feedback)?;

    if output.is_json() {
        if stream {
            return print_json_line(&json!({
                "event": "completed",
                "provider": prov.id(),
                "document": doc,
                "targetLabel": target_label,
                "thread": thread,
                "feedback": feedback,
                "action": "feedbackReplyAdded",
            }));
        }
        return print_json(&json!({
            "provider": prov.id(),
            "document": doc,
            "targetLabel": target_label,
            "thread": thread,
            "feedback": feedback,
            "action": "feedbackReplyAdded",
        }));
    }

    if !stream {
        println!("--- {} feedback ---", prov.display_name());
        println!("{feedback}");
        println!("---");
    } else {
        println!();
        println!("---");
    }
    println!("\nReply saved to thread {}.", thread.id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_revise(
    prov: Provider,
    root: &Path,
    ordinal: Option<usize>,
    thread_id: Option<&str>,
    instruction: Option<&str>,
    pass_name: Option<&str>,
    document: Option<&str>,
    apply: bool,
    resolve: bool,
    stream: bool,
    output: OutputFormat,
) -> Result<(), String> {
    let doc = workspace::resolve_document(root, document)?;
    let (mut thread, target_label) = resolve_thread_selector(root, &doc.id, ordinal, thread_id)?;

    if !output.is_json() {
        println!("{target_label} -> {} \"{}\"", thread.id, thread.title);
        println!("Provider: {} ({})", prov.display_name(), prov.id());
        print_review_context_selection(root, pass_name)?;
        println!();
    }

    let content = workspace::read_document_content(root, &doc.relative_path)?;
    refresh_thread_anchor_if_needed(root, &content, &mut thread)?;
    if let Some(inst) = instruction {
        if !output.is_json() {
            println!("Instruction: {inst}");
            println!();
        }
    }

    let can_use_focused_revise =
        !matches!(thread.anchor.state.as_str(), "detached" | "needs_review");
    let revision = if can_use_focused_revise {
        let target_text = workspace::extract_anchor_text(&content, &thread.anchor)?;
        let prompt = if let Some(inst) = instruction {
            provider::build_focused_revise_prompt_with_instruction(
                &doc.relative_path,
                &thread,
                &target_text,
                inst,
            )
        } else {
            provider::build_focused_revise_prompt(&doc.relative_path, &thread, &target_text)
        };
        let prompt = prepend_review_context(root, pass_name, prompt)?;

        eprintln!("Calling {} in focused revise mode...", prov.display_name());
        let response =
            execute_provider_for_thread(prov, root, &prompt, &mut thread, stream, output)?;
        if !response.success {
            let mut err = format!("{} returned a non-zero exit code.", prov.display_name());
            if !response.stderr.is_empty() {
                err.push_str(&format!("\nstderr: {}", response.stderr.trim()));
            }
            return Err(err);
        }

        let focused = provider::parse_focused_revision_response(prov, &response)?;
        let updated_document_text =
            workspace::replace_anchor_text(&content, &thread.anchor, &focused.replacement_text)?;

        provider::RevisionResult {
            assistant_message: focused.assistant_message,
            updated_document_text,
            resolve_thread_ids: focused.resolve_thread_ids,
        }
    } else {
        let prompt = if let Some(inst) = instruction {
            provider::build_revise_prompt_with_instruction(
                &content,
                &doc.relative_path,
                &thread,
                inst,
            )
        } else {
            provider::build_revise_prompt(&content, &doc.relative_path, &thread)
        };
        let prompt = prepend_review_context(root, pass_name, prompt)?;

        eprintln!(
            "Calling {} in full-document revise mode...",
            prov.display_name()
        );
        let response =
            execute_provider_for_thread(prov, root, &prompt, &mut thread, stream, output)?;
        if !response.success {
            let mut err = format!("{} returned a non-zero exit code.", prov.display_name());
            if !response.stderr.is_empty() {
                err.push_str(&format!("\nstderr: {}", response.stderr.trim()));
            }
            return Err(err);
        }

        provider::parse_revision_response(prov, &response)?
    };

    if !output.is_json() {
        println!("--- {} revision ---", prov.display_name());
        println!("Message: {}", revision.assistant_message);
        println!();
    }

    if apply {
        let (proposal, document_record, resolved_thread) = actions::apply_revision_directly(
            root,
            &mut thread,
            prov,
            &doc,
            &content,
            &revision,
            resolve,
        )?;

        if output.is_json() {
            if stream {
                return print_json_line(&json!({
                    "event": "completed",
                    "provider": prov.id(),
                    "document": document_record,
                    "targetLabel": target_label,
                    "thread": thread,
                    "proposal": proposal,
                    "resolvedThread": resolved_thread,
                    "applied": true,
                    "action": "revisionApplied",
                }));
            }
            return print_json(&json!({
                "provider": prov.id(),
                "document": document_record,
                "targetLabel": target_label,
                "thread": thread,
                "proposal": proposal,
                "resolvedThread": resolved_thread,
                "applied": true,
                "action": "revisionApplied",
            }));
        }

        println!("Diff:");
        println!("{}", proposal.computed_diff);
        println!("---");
        println!(
            "\nApplied revision directly to {}.",
            document_record.relative_path
        );
        println!(
            "Proposal {} saved to history with status {}.",
            proposal.id, proposal.status
        );
        if let Some(resolved_thread) = resolved_thread {
            println!("Thread {} resolved.", resolved_thread.id);
        }
        return Ok(());
    }

    let proposal =
        actions::write_revision_proposal(root, &mut thread, prov, &doc, &content, &revision)?;

    if output.is_json() {
        if stream {
            return print_json_line(&json!({
                "event": "completed",
                "provider": prov.id(),
                "document": doc,
                "targetLabel": target_label,
                "thread": thread,
                "proposal": proposal,
                "applied": false,
                "action": "proposalCreated",
            }));
        }
        return print_json(&json!({
            "provider": prov.id(),
            "document": doc,
            "targetLabel": target_label,
            "thread": thread,
            "proposal": proposal,
            "applied": false,
            "action": "proposalCreated",
        }));
    }

    println!("Diff:");
    println!("{}", proposal.computed_diff);
    println!("---");
    println!("\nProposal {} saved.", proposal.id);
    println!("Review it in the Margent desktop app or accept manually.");
    Ok(())
}

fn cmd_sync(
    prov: Provider,
    root: &Path,
    pass_name: Option<&str>,
    output: OutputFormat,
) -> Result<(), String> {
    if !output.is_json() {
        println!("Starting {} sync...", prov.display_name());
        print_review_context_selection(root, pass_name)?;
    }
    actions::run_sync(root, prov, pass_name)?;
    if output.is_json() {
        return print_json(&json!({
            "provider": prov.id(),
            "action": "syncComplete",
        }));
    }
    println!("{} sync complete.", prov.display_name());
    Ok(())
}

fn prepend_review_context(
    root: &Path,
    pass_name: Option<&str>,
    prompt: String,
) -> Result<String, String> {
    let context = margent_core::review_context::load_review_context(root, pass_name)?;
    Ok(margent_core::review_context::prepend_review_context(
        prompt, &context,
    ))
}

fn print_review_context_selection(root: &Path, pass_name: Option<&str>) -> Result<(), String> {
    let context = margent_core::review_context::load_review_context(root, pass_name)?;
    if context.manual.is_some() {
        println!("Manual: .mdreview/manual.md");
    }
    if context.memory.is_some() {
        println!("Memory: .mdreview/memory.md");
    }
    if let Some(review_pass) = context.review_pass {
        println!("Review pass: {} ({})", review_pass.title, review_pass.name);
    }
    Ok(())
}

// ── Utilities ───────────────────────────────────────────────────────────────

fn execute_provider_for_thread(
    prov: Provider,
    root: &Path,
    prompt: &str,
    thread: &mut models::ThreadRecord,
    stream: bool,
    output: OutputFormat,
) -> Result<provider::ProviderResponse, String> {
    let response = provider::execute_provider_with_options_and_stream(
        prov,
        prompt,
        provider::ProviderExecutionOptions {
            resume_session_id: thread.provider_sessions.get(prov.id()).cloned(),
            stream,
        },
        |event| {
            if !stream {
                return;
            }
            if output.is_json() {
                let _ = print_json_line(&event);
            } else if event.event == "delta" {
                if let Some(text) = event.text.as_deref() {
                    print!("{text}");
                    let _ = std::io::stdout().flush();
                }
            }
        },
    )?;
    if provider::persist_thread_session_from_response(prov, &response, thread) {
        thread.updated_at = workspace::now_rfc3339()?;
        workspace::save_thread(root, thread)?;
    }
    Ok(response)
}

fn resolve_thread_selector(
    root: &Path,
    document_id: &str,
    ordinal: Option<usize>,
    thread_id: Option<&str>,
) -> Result<(models::ThreadRecord, String), String> {
    match (ordinal, thread_id) {
        (Some(ordinal), None) => Ok((
            workspace::resolve_thread_by_ordinal(root, document_id, ordinal)?,
            format!("Thread {ordinal}"),
        )),
        (None, Some(thread_id)) => Ok((
            workspace::resolve_thread_by_id(root, document_id, thread_id)?,
            format!("Thread {thread_id}"),
        )),
        (Some(_), Some(_)) => Err("Pass either a thread ordinal or --id, not both.".into()),
        (None, None) => Err("Pass a thread ordinal or --id <thread_id>.".into()),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max.saturating_sub(3)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        env::temp_dir().join(format!("margent-cli-{label}-{nonce}"))
    }

    #[test]
    fn parses_thread_reply_by_id() {
        let cli = Cli::try_parse_from([
            "margent",
            "threads",
            "reply",
            "--id",
            "thread_123",
            "--body",
            "hello",
        ])
        .expect("parse thread reply by id");

        let Commands::Threads { action } = cli.command else {
            panic!("expected threads command");
        };

        match action {
            ThreadsAction::Reply { thread, body, .. } => {
                assert_eq!(thread.ordinal, None);
                assert_eq!(thread.id.as_deref(), Some("thread_123"));
                assert_eq!(body, "hello");
            }
            _ => panic!("expected reply action"),
        }
    }

    #[test]
    fn parses_provider_revise_by_id() {
        let cli = Cli::try_parse_from([
            "margent",
            "codex",
            "revise",
            "--id",
            "thread_123",
            "--apply",
        ])
        .expect("parse provider revise by id");

        let Commands::Codex { action } = cli.command else {
            panic!("expected codex command");
        };

        match action {
            ProviderAction::Revise { thread, apply, .. } => {
                assert_eq!(thread.ordinal, None);
                assert_eq!(thread.id.as_deref(), Some("thread_123"));
                assert!(apply);
            }
            _ => panic!("expected revise action"),
        }
    }

    #[test]
    fn parses_provider_feedback_review_pass() {
        let cli = Cli::try_parse_from([
            "margent",
            "codex",
            "feedback",
            "--id",
            "thread_123",
            "--pass",
            "fact-check",
        ])
        .expect("parse provider feedback pass");

        let Commands::Codex { action } = cli.command else {
            panic!("expected codex command");
        };

        match action {
            ProviderAction::Feedback { thread, pass, .. } => {
                assert_eq!(thread.id.as_deref(), Some("thread_123"));
                assert_eq!(pass.as_deref(), Some("fact-check"));
            }
            _ => panic!("expected feedback action"),
        }
    }

    #[test]
    fn parses_provider_sync_review_pass() {
        let cli = Cli::try_parse_from(["margent", "claude", "sync", "--pass", "voice"])
            .expect("parse provider sync pass");

        let Commands::Claude { action } = cli.command else {
            panic!("expected claude command");
        };

        match action {
            ProviderAction::Sync { pass } => {
                assert_eq!(pass.as_deref(), Some("voice"));
            }
            _ => panic!("expected sync action"),
        }
    }

    #[test]
    fn parses_doctor_command() {
        let cli = Cli::try_parse_from(["margent", "doctor"]).expect("parse doctor");
        assert!(matches!(cli.command, Commands::Doctor));
    }

    #[test]
    fn parses_open_command() {
        let cli = Cli::try_parse_from([
            "margent",
            "open",
            "draft.md",
            "--thread",
            "thread_123",
            "--print-only",
        ])
        .expect("parse open");

        let Commands::Open {
            document,
            thread,
            print_only,
        } = cli.command
        else {
            panic!("expected open command");
        };

        assert_eq!(document, "draft.md");
        assert_eq!(thread.as_deref(), Some("thread_123"));
        assert!(print_only);
    }

    #[test]
    fn parses_codify_command() {
        let cli = Cli::try_parse_from(["margent", "codify", "--provider", "claude", "--dry-run"])
            .expect("parse codify");

        match cli.command {
            Commands::Codify { provider, dry_run } => {
                assert!(matches!(provider, AgentIdentity::Claude));
                assert!(dry_run);
            }
            _ => panic!("expected codify command"),
        }
    }

    #[test]
    fn parses_reanchor_check_command() {
        let cli = Cli::try_parse_from([
            "margent",
            "reanchor",
            "--check",
            "--dry-run",
            "--document",
            "doc.md",
        ])
        .expect("parse reanchor");

        match cli.command {
            Commands::Reanchor {
                document,
                check,
                dry_run,
            } => {
                assert_eq!(document.as_deref(), Some("doc.md"));
                assert!(check);
                assert!(dry_run);
            }
            _ => panic!("expected reanchor command"),
        }
    }

    #[test]
    fn parses_serve_command() {
        let cli = Cli::try_parse_from([
            "margent",
            "serve",
            "--workspace",
            "/tmp/margent",
            "--port",
            "7444",
            "--token",
            "test-token",
        ])
        .expect("parse serve");

        match cli.command {
            Commands::Serve {
                workspace,
                port,
                token,
            } => {
                assert_eq!(workspace.as_deref(), Some(Path::new("/tmp/margent")));
                assert_eq!(port, 7444);
                assert_eq!(token.as_deref(), Some("test-token"));
            }
            _ => panic!("expected serve command"),
        }
    }

    #[test]
    fn parses_export_commands() {
        let html = Cli::try_parse_from([
            "margent",
            "export",
            "draft.md",
            "--format",
            "html",
            "--output",
            "exports/draft.html",
        ])
        .expect("parse html export");
        match html.command {
            Commands::Export {
                document,
                format,
                gdoc,
                output,
            } => {
                assert_eq!(document, "draft.md");
                assert_eq!(format, Some(export::ExportFormat::Html));
                assert!(!gdoc);
                assert_eq!(output.as_deref(), Some(Path::new("exports/draft.html")));
            }
            _ => panic!("expected export command"),
        }

        let gdoc = Cli::try_parse_from(["margent", "export", "draft.md", "--gdoc"])
            .expect("parse Google Docs export");
        match gdoc.command {
            Commands::Export {
                document,
                format,
                gdoc,
                output,
            } => {
                assert_eq!(document, "draft.md");
                assert_eq!(format, None);
                assert!(gdoc);
                assert_eq!(output, None);
            }
            _ => panic!("expected export command"),
        }
    }

    #[test]
    fn parses_critic_markup_commands() {
        let export_cli = Cli::try_parse_from([
            "margent",
            "export-critic",
            "draft.md",
            "--output",
            "draft.review.md",
            "--include-resolved",
        ])
        .expect("parse export critic");

        match export_cli.command {
            Commands::ExportCritic {
                document,
                output,
                include_resolved,
            } => {
                assert_eq!(document, "draft.md");
                assert_eq!(output.as_deref(), Some(Path::new("draft.review.md")));
                assert!(include_resolved);
            }
            _ => panic!("expected export-critic command"),
        }

        let import_cli = Cli::try_parse_from([
            "margent",
            "import-critic",
            "draft.review.md",
            "--document",
            "draft.md",
            "--dry-run",
        ])
        .expect("parse import critic");

        match import_cli.command {
            Commands::ImportCritic {
                critic_file,
                document,
                dry_run,
                ..
            } => {
                assert_eq!(critic_file, PathBuf::from("draft.review.md"));
                assert_eq!(document, "draft.md");
                assert!(dry_run);
            }
            _ => panic!("expected import-critic command"),
        }
    }

    #[test]
    fn parses_global_json_before_and_after_subcommands() {
        let before = Cli::try_parse_from(["margent", "--json", "threads", "list"])
            .expect("parse global json before command");
        assert!(before.json);

        let after = Cli::try_parse_from(["margent", "threads", "list", "--json"])
            .expect("parse global json after command");
        assert!(after.json);
    }

    #[test]
    fn parses_milestone_one_agent_contract_commands() {
        let events = Cli::try_parse_from([
            "margent", "events", "tail", "--follow", "--since", "evt_123", "--json",
        ])
        .expect("parse events tail");
        assert!(events.json);
        match events.command {
            Commands::Events {
                action: EventsAction::Tail { follow, since },
            } => {
                assert!(follow);
                assert_eq!(since.as_deref(), Some("evt_123"));
            }
            _ => panic!("expected events tail"),
        }

        let proposal = Cli::try_parse_from(["margent", "proposals", "accept", "proposal_123"])
            .expect("parse proposal accept");
        assert!(matches!(
            proposal.command,
            Commands::Proposals {
                action: ProposalsAction::Accept { .. }
            }
        ));

        let file_delete = Cli::try_parse_from(["margent", "files", "delete", "draft.md", "--yes"])
            .expect("parse confirmed file delete");
        match file_delete.command {
            Commands::Files {
                action: FilesAction::Delete { document, yes },
            } => {
                assert_eq!(document, "draft.md");
                assert!(yes);
            }
            _ => panic!("expected file delete"),
        }

        let thread_delete = Cli::try_parse_from(["margent", "threads", "delete", "1", "--yes"])
            .expect("parse confirmed thread delete");
        match thread_delete.command {
            Commands::Threads {
                action: ThreadsAction::Delete { yes, .. },
            } => assert!(yes),
            _ => panic!("expected thread delete"),
        }

        let message_delete =
            Cli::try_parse_from(["margent", "threads", "delete-message", "1", "2", "--yes"])
                .expect("parse confirmed message delete");
        match message_delete.command {
            Commands::Threads {
                action: ThreadsAction::DeleteMessage { message, yes, .. },
            } => {
                assert_eq!(message, 2);
                assert!(yes);
            }
            _ => panic!("expected message delete"),
        }
    }

    #[test]
    fn doctor_inspection_reports_missing_layout() {
        let root = temp_root("doctor-missing");
        fs::create_dir_all(&root).expect("root");

        let snapshot = inspect_workspace_for_doctor(&root);

        assert!(snapshot.documents == 0);
        assert!(snapshot
            .layout_errors
            .iter()
            .any(|error| error.contains(".mdreview/documents")));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn init_scaffold_writes_claude_workspace_guidance() {
        let root = temp_root("init-scaffold-claude");
        fs::create_dir_all(&root).expect("root");
        workspace::ensure_workspace_layout(&root).expect("layout");

        let scaffold = write_agent_package(&root, true).expect("scaffold");

        assert!(root.join("CLAUDE.md").is_file());
        assert!(root.join("AGENTS.md").is_file());
        assert!(root.join(".mcp.json").is_file());
        assert!(root.join(".codex/config.toml").is_file());
        assert!(scaffold
            .created_files
            .iter()
            .any(|file| file == "CLAUDE.md"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn doctor_inspection_counts_workspace_and_warns_on_stale_document() {
        let root = temp_root("doctor-workspace");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("doc.md"), "# Title\n\nOriginal.\n").expect("document");
        workspace::ensure_workspace_layout(&root).expect("layout");
        workspace::upsert_document_record(&root, "doc.md", "# Title\n\nOriginal.\n")
            .expect("document record");
        fs::write(root.join(".mdreview/agents/codex.json"), "{}\n").expect("codex cursor");
        fs::write(root.join(".mdreview/agents/claude.json"), "{}\n").expect("claude cursor");
        fs::create_dir_all(root.join(".claude/commands")).expect("claude commands");
        fs::write(root.join(".claude/commands/margent-review.md"), "review").expect("claude cmd");
        fs::create_dir_all(root.join(".codex")).expect("codex dir");
        fs::write(root.join(".codex/instructions.md"), "instructions").expect("codex instructions");
        fs::write(root.join("doc.md"), "# Title\n\nChanged.\n").expect("changed document");

        let snapshot = inspect_workspace_for_doctor(&root);

        assert!(snapshot.layout_errors.is_empty());
        assert_eq!(snapshot.documents, 1);
        assert_eq!(snapshot.threads, 0);
        assert_eq!(snapshot.proposals, 0);
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains("stale content hashes")));
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains("CLAUDE.md")));
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains(".mcp.json")));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn reanchor_workspace_saves_shifted_thread_anchors() {
        let root = temp_root("reanchor-shifted");
        fs::create_dir_all(&root).expect("root");
        let original = "# Title\n\nTarget sentence.\n";
        fs::write(root.join("doc.md"), original).expect("document");
        workspace::ensure_workspace_layout(&root).expect("layout");
        let document =
            workspace::upsert_document_record(&root, "doc.md", original).expect("document record");
        let anchor = workspace::build_anchor_from_quote(&document, original, "Target sentence.", 1)
            .expect("anchor");
        let thread = workspace::create_thread(
            &root,
            &document,
            "Move check",
            "Follow this sentence.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("thread");
        fs::write(
            root.join("doc.md"),
            "# Title\n\nIntro.\n\nTarget sentence.\n",
        )
        .expect("changed document");

        let stats = reanchor_workspace(&root, Some("doc.md"), false).expect("reanchor");
        let updated = workspace::load_thread(&root, &thread.id).expect("updated thread");

        assert_eq!(stats.documents, 1);
        assert_eq!(stats.threads, 1);
        assert_eq!(stats.changed_threads, 1);
        assert_eq!(updated.anchor.state, "shifted");
        assert_eq!(updated.anchor.start_line, 5);

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn reanchor_workspace_dry_run_reports_blocking_anchor_without_saving() {
        let root = temp_root("reanchor-dry-run");
        fs::create_dir_all(&root).expect("root");
        let original = "# Title\n\nTarget sentence.\n";
        fs::write(root.join("doc.md"), original).expect("document");
        workspace::ensure_workspace_layout(&root).expect("layout");
        let document =
            workspace::upsert_document_record(&root, "doc.md", original).expect("document record");
        let anchor = workspace::build_anchor_from_quote(&document, original, "Target sentence.", 1)
            .expect("anchor");
        let thread = workspace::create_thread(
            &root,
            &document,
            "Detach check",
            "Follow this sentence.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("thread");
        fs::write(root.join("doc.md"), "# Title\n\nNothing similar remains.\n")
            .expect("changed document");

        let stats = reanchor_workspace(&root, Some("doc.md"), true).expect("reanchor dry run");
        let persisted = workspace::load_thread(&root, &thread.id).expect("persisted thread");

        assert_eq!(stats.documents, 1);
        assert_eq!(stats.threads, 1);
        assert_eq!(stats.blocking_open_threads, 1);
        assert_eq!(persisted.anchor.state, "attached");

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn shell_quote_preserves_plain_paths_and_quotes_spaces() {
        assert_eq!(
            shell_quote("/usr/local/bin/margent"),
            "/usr/local/bin/margent"
        );
        assert_eq!(
            shell_quote("/Users/example/Cursor Projects/margent"),
            "'/Users/example/Cursor Projects/margent'"
        );
    }
}
