# Margent

Margent is a local-first macOS Markdown review app: write in a rendered-first CodeMirror editor, attach threaded comments to passages, review agent-authored replies and revision proposals, and keep all review state beside the Markdown in `.mdreview/` JSON sidecars.

![Margent desktop screenshot](docs/assets/margent-app.png)

## Status

Margent is early, macOS-first software. The desktop app, CLI, sidecar schema, exports, provider actions, and updater workflow are actively evolving, but the repository is organized so user documents and review sidecars stay local-first.

Telemetry: Margent does not phone home or collect document content. Provider calls run through the user's own Codex and Claude Code CLIs.

## What Ships

- Desktop app: Tauri 2, React 19, CodeMirror, file/open-with/deep-link support, Review Brief, project search, exports, native notifications, and update checks from GitHub Releases.
- CLI: `margent` for workspace init, file/thread/proposal CRUD, reanchoring, CriticMarkup import/export, `margent serve`, MCP, Codex/Claude provider actions, `codify`, and `margent open`.
- Persistence: Markdown stays as normal files; `.mdreview/` stores documents, threads, proposals, events, agent cursors, review memory, review passes, snapshots, and authorship provenance.

## Prerequisites And First-Run Setup

- macOS.
- Node 22 recommended. Node 20 requires 20.19.0 or newer; older Node 20 builds fail with current Vite tooling.
- Rust stable.
- Optional agent providers: Codex CLI and/or Claude Code. Margent uses whichever of these CLIs you install and log into through their own tools.

Margent does not collect API keys. Agent authentication stays in the provider CLIs and macOS Keychain; the desktop app and CLI only check whether `codex` / `claude` are installed and authenticated.

Provider setup:

```sh
# Codex CLI
# Install: https://developers.openai.com/codex/cli
codex login
codex login status

# Claude Code
# Install: https://docs.anthropic.com/en/docs/claude-code/quickstart
claude auth login
claude auth status
```

Then build/install Margent and run:

```sh
margent doctor
```

`margent doctor` prints the exact next command and documentation link for any missing or unauthenticated provider. Codex login details are in the [Codex CLI reference](https://developers.openai.com/codex/cli/reference#codex-login); Claude Code auth details are in the [Claude Code IAM docs](https://docs.anthropic.com/en/docs/claude-code/iam).

## Build

```sh
npm ci
npm run build
npm test

cargo test --manifest-path crates/margent-core/Cargo.toml
cargo test --manifest-path cli/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml

npm run tauri build
```

The built app is written under `src-tauri/target/release/bundle/macos/Margent.app`.

## CLI Install

From a tapped checkout:

```sh
brew tap Brehove/margent https://github.com/Brehove/margent
brew install margent
```

From source:

```sh
cargo install --locked --path cli
margent doctor
```

## Using Margent With Codex

Mode 1: Codex or Claude Code as a reviewer.

```sh
cd /path/to/markdown-workspace
margent init --write-config
margent doctor
```

`margent init --write-config` creates `.mdreview/`, review pass templates, `.mdreview/skills/margent/SKILL.md`, `.mcp.json`, and `.codex/config.toml`. The generated MCP snippets look like this:

```json
{
  "mcpServers": {
    "margent": {
      "command": "margent",
      "args": ["mcp", "--workspace", "/path/to/markdown-workspace"]
    }
  }
}
```

```toml
[mcp_servers.margent]
command = "margent"
args = ["mcp", "--workspace", "/path/to/markdown-workspace"]
```

Manual equivalents:

```sh
claude mcp add margent -- margent mcp --workspace /path/to/markdown-workspace
codex mcp add margent -- margent mcp --workspace /path/to/markdown-workspace
```

Then ask the agent to review `draft.md`, reply to open threads, propose fixes, or run a pass:

```sh
margent codex feedback --id thread_123 --pass voice
margent claude revise --id thread_123 --pass fact-check
```

Replies and proposals appear live in the desktop app through the `.mdreview/` watchers.

Mode 2: Margent UI inside the Codex in-app browser.

```sh
cd /path/to/markdown-workspace
margent serve --port 7345
```

Open the printed `http://127.0.0.1:7345/?token=...` URL in Codex’s in-app browser. Use `/brief` for the Review Brief route. The browser pane is the shared view; Codex still acts through CLI/MCP primitives. The served UI is localhost-only and token-gated, but the Codex in-app browser does not provide a separate login layer.

Claude uses the same split: Claude Code can act through CLI/MCP, while Chrome can display the `margent serve` URL.

## Opening Codex Output Files In Margent

One-time macOS setup: in Finder, select a `.md` file, choose Get Info, set Open With to Margent, then Change All. After that, `open <file.md>` and many Cmd-click flows route Markdown to Margent.

Best agent handoff: when an agent creates or edits a Markdown file for review, it should run:

```sh
margent open path/to/file.md
```

For a specific thread:

```sh
margent open path/to/file.md --thread thread_123
```

If the file sits under an initialized Margent workspace, `margent open` emits and launches a `margent://open?workspace=...&doc=...&thread=...` deep link so the app opens with full review context. For a plain Markdown file outside a workspace, it falls back to `open -a Margent <file>`.

Manual fallback:

```sh
open -a Margent path/to/file.md
```

## Project Layout

- `src/`: React app and editor UI.
- `src-tauri/`: Tauri desktop app, Rust commands, services, capabilities, signing entitlements.
- `cli/`: Rust CLI, MCP server, serve mode, provider actions.
- `crates/margent-core/`: shared record types, anchor/deep-link/context/CriticMarkup/authorship logic.
- `docs/`: sidecar spec, release notes, schemas, and screenshots.
- `Formula/`: Homebrew formula for the CLI.
- `AGENTS.md`: public agent/contributor conventions.

## Docs

- [Product spec](docs/SPEC.md)
- [Acceptance checklist](docs/ACCEPTANCE.md)
- [`.mdreview` sidecar spec](docs/mdreview-spec.md)
- [Release and distribution](docs/release.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

Margent is licensed under the [MIT License](LICENSE).
