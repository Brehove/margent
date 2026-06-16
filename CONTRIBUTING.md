# Contributing

Thanks for working on Margent. This project is a local-first macOS app plus a Rust CLI, so changes should preserve both the desktop workflow and the agent-facing command surface.

## Setup

```sh
npm ci
npm run build
npm test

cargo test --manifest-path crates/margent-core/Cargo.toml
cargo test --manifest-path cli/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Optional provider checks require the user's own Codex CLI and/or Claude Code installation:

```sh
margent doctor
```

## Pull Requests

- Keep changes scoped to the feature or fix.
- Add or update tests for behavior changes.
- Keep `.mdreview/` fixtures synthetic and sanitized.
- Do not commit provider credentials, local auth config, generated bundles, logs, real review sidecars, or personal absolute paths.
- Use in-app UI or Tauri flows instead of browser modal APIs in production source.

## Verification Gate

Use the smallest meaningful gate while developing, then broaden it before merge when the change touches shared contracts, provider execution, sidecar schemas, editor behavior, or release packaging.

Recommended full gate:

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
```

Run `npm run tauri build` before release-affecting changes or when testing packaged-app behavior.

## Public Hygiene

Before public release or docs-heavy changes, run:

```sh
gitleaks detect --source . --redact --exit-code 1
scripts/check-public-hygiene.sh
```

The hygiene script is a working-tree guard. It complements, but does not replace, GitHub secret scanning and push protection.
