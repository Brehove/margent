# AGENTS.md

## Project

Margent is a local-first macOS Markdown review app. It lets people edit Markdown, anchor threaded comments to passages, review agent-authored replies and revision proposals, and keep review state beside the document in `.mdreview/` JSON sidecars.

The public source tree contains the product code, shared schemas, tests, release wiring, and contributor-facing documentation. Private operator notes, local review content, provider credentials, and machine-specific setup belong outside the tracked tree.

Useful public docs:

- `README.md`: setup, build, CLI, and usage overview
- `CLAUDE.md`: Claude Code-specific repository and workflow guidance
- `docs/product-spec.md`: product behavior and design decisions
- `docs/ACCEPTANCE.md`: user-facing acceptance criteria
- `docs/mdreview-spec.md`: `.mdreview` sidecar layout and schema index
- `docs/release.md`: release, signing, notarization, updater, and Homebrew notes
- `CONTRIBUTING.md`: contributor workflow and verification gates
- `SECURITY.md`: vulnerability reporting and credential model

## Repository Conventions

- Keep source behavior changes close to the relevant boundary: React UI in `src/`, Tauri commands/services in `src-tauri/`, CLI behavior in `cli/`, and shared records/logic in `crates/margent-core/`.
- Keep local review data, provider credentials, generated bundles, logs, and machine-specific overrides out of git.
- Do not commit real `.mdreview/` workspaces. Only sanitized fixtures under `test-fixtures/` are intended to be tracked.
- Do not commit personal absolute paths. Use repo-relative paths in docs and synthetic paths in tests.
- Do not use `window.prompt`, `window.confirm`, or `window.alert` in production source. The packaged WKWebView app should use in-app UI or Tauri plugin flows.
- Prefer deleting dead code over parking it in historical folders. Git history is the archive.
- New behavior should have the smallest meaningful test coverage. Broaden tests for shared record formats, provider execution, sidecar schemas, editor geometry, and release-affecting workflows.

## Architecture

- Frontend: React 19, TypeScript, Zustand, and CodeMirror.
- Desktop shell: Tauri v2 with Rust commands for workspace, document, thread, proposal, export, provider, notification, deep-link, and watcher operations.
- CLI: Rust binary under `cli/`, sharing sidecar records and core behavior with the desktop app.
- Shared core: `crates/margent-core/` owns sidecar records, anchors, exports, review context, provider-adjacent helpers, CriticMarkup, and related reusable logic.
- Persistence: Markdown files remain ordinary user files. Margent writes review metadata to `.mdreview/`.

## Provider Invariants

Provider integrations are intentionally thin wrappers around the user's installed provider CLIs.

- Codex streaming JSONL can report the final assistant text in `item.completed.item.text` for `agent_message` items. Preserve parser coverage for that event shape.
- Claude Code `--output-format stream-json` requires `--verbose` in streaming provider paths.
- Do not hard-code a Claude model in Margent when provider config/default routing should decide it.
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
