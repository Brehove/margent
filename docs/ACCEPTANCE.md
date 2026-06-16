# Acceptance Criteria

Current release-level workflows that should continue to pass.

## App Basics

- Open a folder workspace and see markdown files in the file browser.
- Open a single markdown file and have Margent treat its parent as the workspace.
- Load a document into the CodeMirror editor without mirroring the full draft through global state on every keystroke.
- Save edits from the editor back to disk with updated document metadata.

## Thread Workflows

- Select text and create a new anchored thread from the docked comment pane.
- Click a rail marker or the anchored passage and open the selected thread in the dock.
- Reply to, resolve, reopen, and delete threads from the app.
- Show multiple messages in a selected thread in chronological order.

## CLI Roundtrip

- `margent threads add` creates a new thread that appears in the app without manual reload.
- `margent threads reply` updates an existing thread and the new message appears in the app.
- `margent threads resolve`, `reopen`, and `delete` round-trip correctly between CLI and app.
- Canonical CLI flows that depend on anchors, especially `feedback` and `revise`, refresh anchors against current document content before operating.
- `margent init --write-config` creates Claude-friendly and Codex-friendly workspace instructions: `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.codex/config.toml`, `.mdreview/`, review passes, and the workspace-local Margent skill.
- `margent doctor` reports Claude Code readiness clearly, including whether the Claude CLI/auth, `~/.claude/skills/margent/SKILL.md`, workspace `CLAUDE.md`, and `.mcp.json` are present.

## External Change Handling

- Clean external document edits refresh the open document in the installed app.
- Dirty local edits are preserved when external document edits arrive.
- Deferred external document updates apply once the editor becomes clean again.
- Thread watcher refresh handles atomic CLI rewrites of existing thread files.

## Anchor Behavior

- Live thread positions map through normal insertions and deletions using CodeMirror transaction mapping.
- Same-paragraph markers remain stable and clickable without blinking or collapsing into one marker row.
- Footnote references and definitions created now persist semantic metadata and reattach more accurately than plain quote-only anchors.

## Packaging

- The locally installed app at `~/Applications/Margent.app` can watch active documents and thread files in real workspaces.
- The installed CLI at `~/.cargo/bin/margent` reads and writes the current thread schema without dropping newer anchor metadata.
