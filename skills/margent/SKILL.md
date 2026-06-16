---
name: margent
description: Manage Margent threaded Markdown review workspaces through the margent CLI and MCP server. Use when a user asks to review Markdown drafts, inspect comments, answer or revise anchored threads, propose edits, export documents, or check review state.
version: 0.1.0
---

# Margent Review Skill

This skill is safe to share. It contains no secrets and references only the current working directory, the user's installed `margent` CLI, and local review files.

Margent is a local-first Markdown review system. The Markdown file is the source text. Review state lives beside it in `.mdreview/` JSON sidecars: documents, anchored threads, messages, proposals, events, agent cursors, snapshots, authorship records, review memory, and review passes.

Use Margent when the user wants comments, questions, agent replies, proposed revisions, document exports, or a visible review queue around Markdown drafts.

## Rules

- Use `margent --json` or the Margent MCP server for automation when possible.
- Reply in Margent threads instead of leaving loose review notes in chat.
- Prefer stable IDs (`--id <thread_id>`, `<proposal_id>`) over ordinals when an operation might change the thread set.
- Read `.mdreview/manual.md` before doing review work when it exists.
- Use `.mdreview/skills/*.md` review passes with `--pass <name>` when the user asks for a specific kind of review.
- Do not ask the user for API keys, OAuth tokens, Keychain values, or provider secrets. Codex and Claude authentication belong to their own CLIs.
- Do not silently rewrite a reviewed Markdown document. Create reviewable proposals unless the user explicitly asks for direct edits or direct apply.
- After editing Markdown outside Margent, run `margent reanchor --check --document <relative-path>`.
- Destructive commands require explicit confirmation flags such as `--yes`; ask before deleting or resolving work the user has not clearly approved.

## First Checks

```sh
margent doctor --json
```

If the workspace has not been initialized:

```sh
margent init --write-config
```

That creates `.mdreview/`, review pass templates, workspace-local `CLAUDE.md` and `AGENTS.md` instructions, and MCP registration snippets for Claude Code and Codex.

## Common Workflows

List and inspect Markdown files:

```sh
margent files list --json
margent files read <document.md> --json
margent files outline <document.md> --json
```

Inspect existing review threads:

```sh
margent threads list --document <document.md> --json
margent threads show --id <thread_id> --json
```

Reply inside a thread:

```sh
margent threads reply --id <thread_id> --body "Reply text" --json
```

Create an anchored comment:

```sh
margent threads add --document <document.md> --quote "Exact passage text" --body "Comment text" --json
```

Ask Codex or Claude Code to answer a thread:

```sh
margent codex feedback --id <thread_id> --pass voice --json
margent claude feedback --id <thread_id> --pass fact-check --json
```

Ask Codex or Claude Code to propose a revision:

```sh
margent codex revise --id <thread_id> --pass voice --json
margent claude revise --id <thread_id> --instruction "Tighten this without changing the claim." --json
```

Review pending proposals:

```sh
margent proposals list --status pending --json
margent proposals show <proposal_id> --json
margent proposals accept <proposal_id> --json
margent proposals reject <proposal_id> --json
```

Export a document:

```sh
margent export <document.md> --format docx --output <document.docx> --json
margent export-critic <document.md> --output <document.critic.md> --json
```

Open a document or thread in the desktop app:

```sh
margent open <document.md>
margent open <document.md> --thread <thread_id>
```

## Provider Notes

- `margent codex ...` calls the user's installed Codex CLI.
- `margent claude ...` calls the user's installed Claude Code CLI.
- If you are running inside Claude Code, prefer `margent claude ...` for provider-backed replies and revisions. Codex examples are for Codex sessions or for users who explicitly ask to route work through Codex.
- Margent does not manage provider accounts. If provider auth is missing, tell the user to run the provider's own login command and complete the browser or OAuth step themselves.
- `feedback` writes an agent reply into the thread. `revise` creates a proposal unless `--apply` is explicitly used.

## MCP

Register the workspace server with:

```sh
margent mcp --workspace <workspace-root>
```

Use MCP tools for atomic primitives: list/read documents, list/get/create/reply/resolve/reopen threads, list/get/accept/reject proposals, reanchor threads, and inspect events since a cursor.

## When Not To Use Margent

- Do not create a Margent thread for a trivial direct edit the user has already requested.
- Do not use Margent for non-Markdown files unless the user is exporting, converting, or explicitly asking to create a Markdown review workflow.
- Do not scan unrelated folders outside the current project unless the user asks you to.
