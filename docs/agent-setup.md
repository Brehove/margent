# Agent Setup

Use this guide when a user asks you to install Margent from Claude Code, Codex,
OpenClaw, or another local agent that can run shell commands.

Margent is a local-first Markdown writing editor. It keeps the user's Markdown
files in place and stores review metadata in `.mdreview/` sidecars beside those
files. The repo includes both the `margent` CLI and a shared agent skill for
Claude Code and Codex. Margent does not collect documents, prompts, comments,
API keys, OAuth tokens, or analytics.

Provider authentication is not part of the Margent repo. Codex and Claude Code
authentication must be initiated by the user through the provider's own CLI.
Never ask the user to paste API keys, OAuth tokens, Keychain values, or provider
secrets into chat.

## What To Do

1. Confirm the user is on macOS.
2. Confirm Git, Node 22 or newer, npm, and Rust stable are available.
3. Clone or update the repo:

   ```sh
   git clone https://github.com/Brehove/margent.git
   cd margent
   ```

   If the repo already exists, inspect `git status` first. Do not overwrite
   local changes. Fetch or pull only when the working tree is clean, or after
   the user explicitly approves the update.

4. Install dependencies and run the basic checks:

   ```sh
   npm ci
   npm run build
   npm test
   cargo test --manifest-path crates/margent-core/Cargo.toml
   cargo test --manifest-path cli/Cargo.toml
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

5. Install the Margent CLI and shared agent skill:

   ```sh
   cargo install --locked --path cli
   margent install --agent-skills
   margent doctor
   ```

   `margent install --agent-skills` copies the same public skill package into
   `~/.claude/skills/margent` and `~/.codex/skills/margent`. If either skill
   already exists, leave it untouched unless the user explicitly approves
   `margent install --agent-skills --force`.

6. Build or run the desktop app:

   ```sh
   npm run tauri dev
   ```

   For a release-style local app build:

   ```sh
   npm run tauri build
   open src-tauri/target/release/bundle/macos/Margent.app
   ```

7. Check provider readiness:

   ```sh
   codex login status
   claude auth status
   ```

   If either provider is missing, send the user to the provider's official
   install docs. If either provider is installed but not authenticated, ask the
   user to initiate the provider login:

   ```sh
   codex login
   claude auth login
   ```

   The user must complete the browser/OAuth step themselves. Do not collect or
   inspect tokens.

8. Ask exactly one setup preference question:

   ```text
   Should Margent default to Codex, Claude Code, or ask each time?
   ```

9. Open a sample Markdown workspace and demonstrate one round trip:

   - select a passage
   - create a comment
   - choose Codex or Claude
   - run Ask for explanation or Revise for a proposed edit
   - show that replies and proposals stay attached to the selected passage

## If Something Fails

Summarize the failing command, current directory, operating system, Node version,
Rust version, and the first useful error message. Do not include provider tokens,
private documents, real `.mdreview/` content, or personal paths unless the user
explicitly approves sharing them in a GitHub issue.

Useful links:

- Repo: https://github.com/Brehove/margent
- Issues: https://github.com/Brehove/margent/issues
- Codex CLI docs: https://developers.openai.com/codex/cli
- Claude Code docs: https://docs.anthropic.com/en/docs/claude-code/quickstart
