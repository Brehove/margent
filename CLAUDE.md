# CLAUDE.md

## Project

Margent is a local-first macOS Markdown review app. It lets people edit Markdown, anchor threaded comments to passages, review Claude Code or Codex replies and revision proposals, and keep review state beside the document in `.mdreview/` JSON sidecars.

The public source tree contains the product code, shared schemas, tests, release wiring, agent skill, and contributor-facing documentation. Private operator notes, local review content, provider credentials, and machine-specific setup belong outside the tracked tree.

Useful public docs:

- `README.md`: setup, build, CLI, and usage overview
- `docs/agent-setup.md`: agent-first installation guide
- `docs/product-spec.md`: product behavior and design decisions
- `docs/ACCEPTANCE.md`: user-facing acceptance criteria
- `docs/mdreview-spec.md`: `.mdreview` sidecar layout and schema index
- `docs/release.md`: release, signing, notarization, updater, and Homebrew notes
- `CONTRIBUTING.md`: contributor workflow and verification gates
- `SECURITY.md`: vulnerability reporting and credential model

## Claude Code Rules

- Prefer `margent --json` or the Margent MCP server for review operations.
- Prefer `margent claude ...` commands when asking Claude Code to answer comments or propose revisions.
- Use `margent codex ...` only when the user explicitly wants Codex.
- Run `margent init --write-config` inside a writing workspace so Claude Code gets `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, review passes, and `.mdreview/`.
- If MCP is not already registered, run `claude mcp add margent -- margent mcp --workspace <workspace-root>`.
- Read `.mdreview/manual.md` before reviewing when it exists; it is standing context for that workspace.
- Never silently edit a reviewed Markdown document. Use Margent proposals for changes that need human approval unless the user explicitly asks for direct edits.
- After external Markdown edits, run `margent reanchor --check --document <relative-path>`.
- Do not ask for API keys, OAuth tokens, Keychain values, or provider secrets. Claude authentication belongs to Claude Code through `claude auth login`.

## Repository Conventions

- Keep source behavior changes close to the relevant boundary: React UI in `src/`, Tauri commands/services in `src-tauri/`, CLI behavior in `cli/`, and shared records/logic in `crates/margent-core/`.
- Keep local review data, provider credentials, generated bundles, logs, and machine-specific overrides out of git.
- Do not commit real `.mdreview/` workspaces. Only sanitized fixtures under `test-fixtures/` are intended to be tracked.
- Do not commit personal absolute paths. Use repo-relative paths in docs and synthetic paths in tests.
- Do not use `window.prompt`, `window.confirm`, or `window.alert` in production source. The packaged WKWebView app should use in-app UI or Tauri plugin flows.
- Prefer deleting dead code over parking it in historical folders. Git history is the archive.

## Provider Invariants

Provider integrations are intentionally thin wrappers around the user's installed provider CLIs.

- Claude Code `--output-format stream-json` requires `--verbose` in streaming provider paths.
- Do not hard-code a Claude model in Margent when Claude Code config/default routing should decide it.
- Provider auth belongs to the provider CLIs and the user's system credential store, not to Margent source files.

## Verification

Before merging behavior changes, run the relevant subset of:

```sh
npm run build
npm test
npm run perf:report

cargo test --manifest-path crates/margent-core/Cargo.toml
cargo clippy --manifest-path crates/margent-core/Cargo.toml --all-targets -- -D warnings

cargo test --manifest-path cli/Cargo.toml
cargo clippy --manifest-path cli/Cargo.toml --all-targets -- -D warnings

cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

npm run tauri build
```

For publication work, also run:

```sh
gitleaks detect --source . --redact --exit-code 1
scripts/check-public-hygiene.sh
```

Desktop packaging, updater, deep-link, file-association, and provider-flow changes need a packaged-app smoke test in addition to unit/integration tests.
