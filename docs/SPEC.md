# Markdown Comment App Spec

## Product Summary

Build a local-first macOS app for reviewing and revising Markdown documents with threaded comments and AI/CLI-assisted edits.

The app should feel like a local version of Lex for Markdown files:

- open local `.md` files from disk
- select text and attach threaded comments
- reply to comments inside the app
- let external agents add comments or reply inside existing threads through a terminal-first CLI bridge
- let external agents see when the user has replied and continue the conversation
- use a terminal CLI to target specific comments or threads and ask for feedback or revisions
- receive structured agent actions, including proposed revisions
- preview the patch
- approve or reject the patch
- keep comments and edit history separate from the Markdown source file

The system must not depend on any single model vendor or cloud editor.

## Core Product Principles

- Local-first: Markdown files remain ordinary files on disk.
- Portable: comments and proposals live in sidecar data, not inside the Markdown body.
- Vendor-neutral: any CLI can participate if it can read stdin or a JSON request and emit a structured response.
- Approval-first: no AI-generated change is applied silently.
- Durable anchors: comments should survive ordinary edits, file renames, and document revisions when possible.
- Human-readable data: metadata should be inspectable and git-friendly.

## Primary Use Cases

- A writer opens a Markdown draft, selects a sentence, and leaves a comment.
- The writer replies to a thread with instructions such as "tighten this paragraph" or "make this sound less academic."
- The writer uses `margent` in Terminal to say, in effect, "look at my third comment and provide feedback."
- The writer uses `margent` in Terminal to say, in effect, "look at my third comment and revise the text accordingly."
- An external agent such as Codex or Claude Code adds its own comment thread when it spots a likely issue.
- An external agent replies directly inside a thread after the writer asks a follow-up question.
- The writer replies to an agent-authored message, and the agent can pick that up later and continue the thread.
- The writer chooses a provider/backend through `margent`, such as Codex, Claude Code, Aider, or a generic shell backend.
- The CLI returns either an updated document or a proposed patch.
- The app renders the diff and lets the writer accept or reject it.
- The app records which thread prompted the change and can mark the thread resolved.
- Multiple CLIs can be configured and swapped per task without changing the file format.

## Non-Goals

- Real-time multi-user collaboration in v1
- Native sync or hosted storage in v1
- Google Docs style shared cloud comments in v1
- Rich block databases or wiki features
- Full plugin ecosystem in v1
- Perfect anchor recovery under arbitrary rewrites

## Success Criteria

- A user can review and revise a Markdown file end to end without leaving the app.
- A user can add, reply to, resolve, and reopen comment threads.
- A user can connect at least one external CLI that can add comments, reply in threads, and propose revisions.
- An agent can tell when the user has replied to one of its messages and continue the conversation without losing context.
- The app can show a patch preview before applying any edit.
- Comments remain attached through common edits such as insertions above the selected text, nearby rewrites, or heading changes.
- The raw `.md` file remains valid Markdown and contains no proprietary comment markup.

## Target Platform

- macOS desktop app
- Minimum target: macOS 14+ recommended
- Local-first, single-user in v1

Rationale:

- The product needs a desktop UX, local file access, and reliable subprocess execution for CLIs.
- It does not require a cloud backend or a browser-hosted editor in v1.
- The stack should optimize for rich editor interactions, comments, suggestions, and CLI interoperability.

## Implementation Recommendation

Do not lock the product to Swift as a requirement.

Recommended implementation for v1:

- Tauri desktop shell
- React or similar web UI
- CodeMirror 6 for source editing
- local Rust or Node host layer for filesystem access and CLI subprocess execution

Why this is the better default:

- a Lex-like comment pane and suggestion workflow are easier to build with mature web editor tooling
- diff rendering, threaded side panels, keyboard interactions, and inline decorations are easier in the web editor ecosystem
- local desktop packaging and subprocess control are still strong with Tauri
- the app remains a real local Mac app, not a hosted web product

Acceptable alternative:

- SwiftUI/AppKit native app if native feel becomes more important than development speed

Current recommendation:

- prefer Tauri over SwiftUI for MVP

Reason:

- your hardest problem is not macOS chrome, it is editor behavior plus comment and CLI orchestration

## User Experience

## Main Window

Three-pane layout:

- Left sidebar: file browser, document outline, thread filters, unresolved count
- Center pane: Markdown editor with optional rendered preview toggle
- Right sidebar: selected thread, replies, CLI actions, proposal details

## Primary Actions

- Open folder or single Markdown file
- Select text and create comment
- Reply to thread
- Inspect or copy a Terminal command for the selected thread
- Preview proposed change
- Accept change
- Reject change
- Resolve or reopen thread

## Document Modes

- Edit mode: source-first Markdown editing
- Review mode: thread-focused view with inline comment markers and diff overlays
- Preview mode: rendered Markdown preview, read-only in v1

## UX Reference Direction

The product should feel closer to:

- Lex for comments, revision workflow, and AI collaboration
- Scratch for local Markdown file browsing and file ownership

It should feel less like:

- Google Docs cloud collaboration
- a code IDE with comments bolted on
- a pure note-taking app

## MVP UX Constraint

In v1, comments are anchored to source text in the Markdown editor, not to the rendered preview DOM.

This keeps anchoring tractable and avoids building a fragile preview-to-source mapping layer too early.

The center of gravity for the product is the comment pane and revision workflow, not WYSIWYG rendering.

## Data Model

## Workspace Layout

For a workspace root:

```text
workspace/
  draft.md
  notes/essay.md
  .mdreview/
    workspace.json
    documents/
      <document-id>.json
    threads/
      <thread-id>.json
    proposals/
      <proposal-id>.json
    agents/
      <agent-id>.json
    events.ndjson
```

If a user opens a single file, the parent directory becomes the workspace root.

## Why `.mdreview/`

- Hidden, local-first metadata
- Works with git
- Easy for external CLIs to read
- Avoids contaminating the Markdown source
- Supports more than one reviewed document in the same folder

## Document Record

Each document record should include:

- `id`
- `relativePath`
- `displayName`
- `createdAt`
- `updatedAt`
- `currentContentHash`
- `lastKnownLineEnding`
- `frontmatterMode`
- `wordCount`
- `headingIndex`

`headingIndex` is derived metadata used to improve anchor recovery and thread navigation.

## Thread Record

Each thread file should include:

- `id`
- `documentId`
- `status` with values `open`, `resolved`, `archived`
- `createdAt`
- `updatedAt`
- `createdBy`
- `title`
- `tags`
- `anchor`
- `messages`
- `linkedProposalIds`

## Message Record

Each thread message should include:

- `id`
- `threadId`
- `authorType` with values such as `user`, `agent`, `system`
- `authorName`
- `agentId` if generated by an agent such as `codex` or `claude`
- `providerId` or `adapterId` if generated through a specific backend path
- `replyToMessageId` when the message is explicitly responding to another message
- `createdAt`
- `body`
- `kind` with values such as `comment`, `reply`, `instruction`, `summary`

## Anchor Record

Anchors must be redundant to survive edits. Store:

- `quote`
- `prefixContext`
- `suffixContext`
- `startOffsetUtf16`
- `endOffsetUtf16`
- `startLine`
- `startColumn`
- `endLine`
- `endColumn`
- `headingPath`
- `blockFingerprint`
- `baseContentHash`

`blockFingerprint` is a normalized hash of the containing paragraph or list item at the time the comment was created.

## Proposal Record

Each proposal should include:

- `id`
- `documentId`
- `threadIds`
- `providerId` or `adapterId`
- `createdAt`
- `status` with values `pending`, `accepted`, `rejected`, `stale`, `failed`
- `baseContentHash`
- `responseMode`
- `summary`
- `assistantMessage`
- `updatedDocumentText` or `unifiedDiff`
- `computedDiff`
- `warnings`

## Event Log

Append-only `events.ndjson` should record:

- thread created
- message added
- proposal requested
- proposal received
- proposal accepted
- proposal rejected
- thread resolved
- thread reopened
- agent sync started
- agent sync completed
- agent cursor advanced

This provides auditability without requiring a database in v1.

## Agent Cursor Record

Each agent state record in `.mdreview/agents/<agent-id>.json` should include:

- `agentId`
- `providerId` or `adapterId`
- `lastSeenEventId`
- `lastSyncedAt`
- `lastSyncStatus`
- `notes` or short diagnostic text if the last sync failed

This cursor state is what lets an agent notice that the user replied to one of its messages and continue the thread without rereading the full history every time.

## Anchoring Strategy

## Goal

Keep comment threads attached to the right text through common document edits.

## Reattachment Algorithm

When a document changes, re-anchor in this order:

1. Exact range reuse if `baseContentHash` still matches
2. Exact quote match in the current document
3. Quote plus prefix/suffix context match
4. Heading-constrained quote search
5. Block fingerprint match
6. Fuzzy text match within the nearest heading scope
7. Mark thread as `needs review` if confidence is too low

Each re-anchor attempt should yield a confidence score.

## Anchor States

- `attached`
- `shifted`
- `fuzzy`
- `detached`
- `needs_review`

Threads in `needs_review` should remain visible and require explicit user confirmation before a CLI uses them as precise text targets.

## CLI Integration Model

## Product Requirement

The app must not be hard-wired to a single AI coding or writing tool.

The app should treat CLI agents as collaborators that can read thread context, propose edits, reply into threads, and suggest resolution state.

The primary control surface for agent work should be the Margent CLI, installed as the `margent` command in Terminal. The desktop app should focus on document editing, thread review, and proposal approval.

## Preferred Agent Architecture

The long-term architecture should prefer one stable local bridge, the Margent CLI, rather than teaching the desktop app every provider-specific prompt and output detail.

Recommended shape:

- the app owns files, anchors, threads, approvals, and event logging
- `margent` is the primary user-facing control surface for agent work
- the Margent CLI owns the agent protocol and provider-specific prompt/output normalization
- Codex and Claude sit behind the Margent CLI, not directly inside the desktop app

Example commands:

- `margent codex sync`
- `margent claude sync`
- `margent codex feedback 3`
- `margent codex revise 3`

In this model, the app watches the sidecar state and reflects the results. It does not need to be the place where the user launches Codex or Claude.

The current app-level provider wrappers are legacy code and should be removed. The stable product direction should rely on the Margent CLI only.

## Terminal-First CLI Model

The user-facing CLI command should be `margent`. It should be usable directly from Terminal without requiring the desktop app to initiate agent actions.

Core commands should include:

- `margent install`
- `margent init`
- `margent doctor`
- `margent threads list`
- `margent threads show 3`
- `margent codex feedback 3`
- `margent codex revise 3`
- `margent claude reply 3 2 --instruction "respond to this"`
- `margent codex sync`

The app should remain useful while the CLI is running, but the CLI should be fully capable of writing thread replies, proposals, and cursor updates into `.mdreview/` on its own.

## CLI Installation and Workspace Bootstrap

Installation should be simple and terminal-first:

- the app may offer an "Install CLI" action, but the result should be a normal `margent` command on `PATH`
- a standalone installer or Homebrew formula is also acceptable
- `margent install` should verify that the command is available on `PATH` and print shell-specific next steps if it is not
- `margent doctor` should verify `codex`, `claude`, auth state, and basic workspace compatibility

Workspace bootstrap should be explicit:

- `margent init` runs in the workspace root
- it ensures `.mdreview/` exists
- it writes any managed workspace-local integration files that Codex or Claude need in order to work well from that root
- it records any needed workspace metadata for selector resolution and agent cursors

If Codex or Claude benefit from project-local commands, prompts, or skills that live in the workspace root or provider-specific hidden folders, `margent init` should create and maintain those files automatically. The user should not have to author raw provider commands by hand.

## Thread and Message Selectors

The CLI should support both stable ids and human-friendly ordinal selectors.

Thread selectors:

- `margent codex feedback 3`
- `--thread thread_123`
- `--thread 3`

Message selectors:

- `margent claude reply 3 2 --instruction "respond to this"`
- `--message msg_8`
- `--message 2`

Ordinal selectors should resolve against a documented ordering, such as the current document's visible thread order or a thread's message order sorted by creation time. The CLI should print the resolved ids before running an agent action so the user can confirm that "third comment" mapped to the intended thread or message.

Natural-language phrasings such as "look at my third comment and provide feedback" are acceptable as a UX goal, but the canonical contract should be short `margent` commands with explicit selectors that the CLI resolves before sending context to Codex or Claude.

## CLI Backend Design

The primary product direction should not rely on app-managed Codex or Claude presets.

The Margent CLI should keep its own provider/backend configuration in a user-level config and any necessary workspace metadata in `.mdreview/`.

If a generic shell backend remains for advanced users, treat it as a secondary feature rather than the main workflow.

## Provider Discovery and Launch

The Margent CLI should discover providers in this order:

1. user-configured absolute path
2. executable found on `PATH`
3. workspace-local managed integration files created by `margent init`

For a CLI like Codex, the Margent CLI should not try to attach to an already-open terminal session.

Instead, the Margent CLI should:

- locate the `codex` executable
- verify availability with a lightweight command
- verify login state
- launch a fresh subprocess for each request

This is the right model because the Margent CLI needs deterministic input, deterministic output capture, and explicit lifecycle management.

## Authentication Model

For CLIs that manage their own identity, the Margent CLI should not ask for or store provider credentials.

For Codex specifically:

- the Margent CLI should rely on the locally installed `codex` CLI
- the CLI should manage its own login state
- the Margent CLI should check status with `codex login status`
- if not logged in, `margent doctor` or the active `margent` command may trigger `codex login --device-auth` or prompt the user to complete login in Terminal

This keeps ChatGPT-account-based access inside Codex itself rather than moving authentication into the app.

For Claude Code specifically:

- the Margent CLI should rely on the locally installed `claude` CLI
- the CLI should manage its own login state
- the Margent CLI should check status with `claude auth status`
- if not logged in, `margent doctor` or the active `margent` command may trigger `claude auth login` or prompt the user to complete login in Terminal

This keeps Claude-account-based access inside Claude Code itself rather than moving authentication into the app.

## Environment Inheritance Requirements

If the Margent CLI launches Codex, it should do so under the same macOS user context and preserve the environment needed for Codex to behave like the terminal-installed tool.

At minimum, the Margent CLI should preserve or explicitly configure:

- `HOME`
- `PATH`
- `CODEX_HOME` if set
- working directory
- any provider-specific allowlisted variables

This matters because Codex behavior depends on local state such as:

- login/session state
- `~/.codex/config.toml`
- installed skills in `CODEX_HOME/skills` or `~/.codex/skills`
- configured MCP servers
- project trust settings

If these are preserved, a Margent-launched Codex subprocess should behave like the same Codex installation you use in Terminal.

The same principle should apply to Claude Code. If the Margent CLI launches `claude` under the same user context and preserves the needed environment and working directory, it should behave like the same Claude Code installation you use in Terminal, including local settings, MCP configuration, and CLI-managed authentication state.

## Codex and Claude Code Integration Shape

Codex and Claude Code should be treated as external agent binaries, not as APIs embedded into the app.

Recommended flow:

- the user or app creates a structured request object
- the user or app calls `margent`
- `margent` converts the request into the provider-specific prompt or prompt bundle
- `margent` launches `codex exec` or `claude -p`
- the provider returns a final response
- `margent` normalizes the result into Margent action JSON

This keeps provider quirks in one place and makes the desktop app care about one stable contract instead of multiple CLI-specific ones.

## CLI Execution Contract

CLI execution should be simple and strict:

- `margent` launches the provider command as a subprocess
- request JSON is passed by stdin in v1
- stdout must contain one valid JSON response object
- stderr is treated as diagnostic output and shown in the UI if the run fails
- exit code `0` means success if stdout is valid
- any non-zero exit code marks the run failed

For provider-backed agents, the preferred execution path is always `margent`, with Codex and Claude handled behind that layer.

This avoids fragile prompt scraping in the desktop app and makes adapter behavior easier to test from Terminal.

## Proof-Inspired Operation Model

Borrow the interaction vocabulary from collaborative writing systems such as Proof SDK, but keep the storage local-first.

The app should support a stable internal operation layer with concepts like:

- `thread.create`
- `thread.reply`
- `thread.resolve`
- `thread.reopen`
- `agent.sync`
- `agent.noop`
- `suggestion.create`
- `suggestion.accept`
- `suggestion.reject`
- `rewrite.propose`
- `rewrite.apply`

These are internal app operations, not network API requirements.

Why this matters:

- it cleanly separates UI actions from storage
- it cleanly separates storage from CLI backends
- it makes future automation, scripting, and multi-agent workflows easier
- it gives the app a more Lex-like collaboration model than a simple "run prompt, replace file" model

## Scratch-Like File Model

The app should preserve one of Scratch's best qualities:

- local file ownership stays obvious
- file browsing feels lightweight
- the user can open ordinary Markdown files without importing them into a proprietary database

The app should therefore avoid:

- opaque document import steps
- cloud-only slugs or document IDs as the primary user-facing identity
- storing the canonical document body in an internal database

## Context Packing Rules

The app should not send the entire workspace by default.

The default request payload should include:

- the active document
- the selected thread
- the resolved thread selector and message selector, if the request came from a terminal command like `margent codex feedback 3`
- an optional small set of nearby or explicitly linked threads
- explicit user instructions
- agent cursor state when the request is part of an agent sync cycle
- recent events since the agent's last cursor position when the goal is continued conversation

The app may support broader context modes later, but v1 should prefer narrow, predictable context to reduce cost and reduce accidental rewrites.

## Request Contract

The app or CLI should generate a structured request JSON and pass it to the provider backend through stdin or a temp file.

Request shape:

```json
{
  "schemaVersion": 1,
  "task": "propose_revision",
  "workspaceRoot": "/path/to/workspace",
  "document": {
    "id": "doc_123",
    "relativePath": "draft.md",
    "content": "# Draft\n...",
    "contentHash": "sha256:...",
    "selection": {
      "startOffsetUtf16": 120,
      "endOffsetUtf16": 190
    }
  },
  "thread": {
    "id": "thread_123",
    "ordinal": 3,
    "status": "open",
    "anchor": {
      "quote": "Original sentence here."
    },
    "messages": [
      {
        "id": "msg_7",
        "ordinal": 1,
        "authorType": "user",
        "body": "Tighten this paragraph and reduce repetition."
      },
      {
        "id": "msg_8",
        "ordinal": 2,
        "authorType": "agent",
        "agentId": "claude",
        "body": "I can revise this, or I can leave it and just flag the repeated phrase."
      }
    ]
  },
  "relatedThreads": [],
  "selector": {
    "thread": 3,
    "message": null
  },
  "agentState": {
    "agentId": "claude",
    "lastSeenEventId": "evt_1042"
  },
  "instructions": "Revise only what is necessary to address the thread.",
  "preferredResponseMode": "updated_document"
}
```

## Agent Action Contract

The preferred response contract for agent participants is an action envelope, not a single provider-specific proposal blob.

Action shape:

```json
{
  "status": "ok",
  "actions": [
    {
      "type": "reply_to_thread",
      "threadId": "thread_123",
      "replyToMessageId": "msg_8",
      "body": "I agree. I can tighten this now if you want."
    },
    {
      "type": "propose_revision",
      "threadId": "thread_123",
      "assistantMessage": "I tightened the paragraph and removed two repetitive sentences.",
      "responseMode": "updated_document",
      "updatedDocumentText": "# Draft\n...",
      "resolveThreadIds": ["thread_123"]
    }
  ],
  "warnings": []
}
```

Supported action types should include:

- `add_thread`
- `reply_to_thread`
- `propose_revision`
- `noop`

For terminal-first usage, `feedback` and `revise` should be CLI verbs that map onto these actions:

- `feedback` usually produces `reply_to_thread`
- `revise` usually produces `propose_revision`
- `sync` may produce any mix of `add_thread`, `reply_to_thread`, `propose_revision`, or `noop`

`propose_revision` still requires explicit user review and acceptance before the Markdown file is changed on disk.

## Proposal Response Contract

For simple one-shot backends or transitional internal code, the app should still accept a direct proposal response:

The app should accept any of these response modes:

- `updated_document`
- `unified_diff`
- `edit_operations`

Preferred MVP mode:

- `updated_document`

Reason:

- simplest for external CLIs
- easiest to validate
- easiest for the app to diff locally

Response shape:

```json
{
  "status": "ok",
  "responseMode": "updated_document",
  "assistantMessage": "I tightened the paragraph and removed two repetitive sentences.",
  "updatedDocumentText": "# Draft\n...",
  "resolveThreadIds": ["thread_123"],
  "warnings": []
}
```

## Validation Rules

Before the app accepts a CLI response:

- confirm the base document hash still matches, or mark the proposal stale
- verify the response is parseable
- compute a local diff
- reject no-op outputs unless explicitly allowed
- cap large rewrites behind an extra confirmation step

## Patch Workflow

## Proposal Lifecycle

1. User selects a thread
2. User runs a `margent` command or chooses a provider-aware command from the app
3. Margent packages document and thread context
4. The provider returns proposed output through `margent`
5. App computes and renders diff
6. User accepts or rejects
7. If accepted, app writes the Markdown file to disk
8. Related thread may be auto-resolved or kept open

## Acceptance Rules

- No proposal is auto-applied in v1
- If the document changed on disk after proposal generation, the proposal becomes `stale`
- A stale proposal must be regenerated or manually rebased

## Comment-to-Revision Workflow

This is the main product loop:

1. User comments on a span
2. User replies with intent
3. User invokes a CLI, or an agent notices a new event through its cursor
4. Agent adds a comment, replies in-thread, or proposes a revision
5. User reviews any proposed revision
6. App applies change only after explicit approval
7. Thread is resolved or remains open for follow-up

## File System Behavior

## Watching

The app should watch:

- Markdown source files
- `.mdreview/threads`
- `.mdreview/proposals`
- workspace CLI metadata

## External Edits

If a file changes outside the app:

- reload content
- attempt anchor reattachment
- invalidate or mark stale any open proposals built against the old hash
- preserve thread history

## Rename and Move Handling

Inside an opened workspace, file renames and moves should update `relativePath` in the document record.

If a file disappears entirely, its threads should be retained and marked orphaned until relinked or removed.

## UI Details

## Thread Markers

In source view:

- show subtle gutter markers for anchored comments
- highlight active anchor range
- indicate anchor confidence when reattachment is fuzzy

## Thread Sidebar

Each thread card should show:

- status
- excerpt of anchored quote
- latest message
- provider badge if an agent has responded
- unresolved/resolved state

## Proposal Review UI

Proposal review should show:

- summary of intent
- assistant message
- file diff
- controls for accept, reject, or copy patch

## Settings

Settings should include:

- CLI installation status
- preferred provider
- path to the installed `margent` command, if not on the default `PATH`
- `margent doctor` diagnostics
- timeout settings
- auto-resolve suggestion behavior
- whether `.mdreview/` should be added to `.gitignore`

## Architecture

## App Modules

- `WorkspaceManager`: file access, workspace layout, watchers
- `DocumentStore`: load/save Markdown files and metadata
- `ThreadStore`: read/write thread records
- `AgentStateStore`: read/write per-agent cursor and sync state
- `AnchorEngine`: attach and reattach comments
- `ProviderRunner`: execute provider CLIs and normalize responses
- `AgentCoordinator`: package agent sync requests and apply returned actions
- `ProposalEngine`: validate, diff, and stage proposed revisions
- `EditorController`: selection, inline markers, thread actions
- `EventLogger`: append-only audit events

## Persistence Choice

Use JSON files plus NDJSON event log for v1.

Do not introduce SQLite unless scale or query complexity clearly demands it.

Reason:

- easier to inspect
- easier for CLIs to consume directly
- easier to back up and version with git

## Security and Trust Model

- The Margent CLI executes local commands with explicit user configuration
- Environment variables exposed to provider CLIs must be allowlisted
- The app or CLI should show the exact command and working directory used when requested
- Network behavior belongs to Codex or Claude, not to the app itself
- The app should never grant background file access beyond the opened workspace
- The CLI should support a dry-run or doctor mode

## Failure Modes

- provider backend returns invalid JSON
- provider backend times out
- proposal is based on a stale document hash
- anchor cannot be confidently reattached
- file changed externally during review
- provider backend proposes destructive whole-document rewrite

Each failure should have a recoverable UI path, not a silent drop.

## Testing Strategy

## Unit Tests

- anchor creation
- anchor reattachment
- heading path extraction
- proposal validation
- diff computation
- provider response parsing

## Integration Tests

- open workspace and persist thread metadata
- create comment and reload app
- run a fake provider backend that returns updated document text
- accept proposal and verify file write
- reject proposal and verify no file write
- handle external file edits between proposal creation and acceptance

## Fixture Cases

Include Markdown fixtures for:

- frontmatter
- headings
- lists
- blockquotes
- code fences
- long paragraphs
- duplicate sentences in different sections

Duplicate text fixtures are important for anchor confidence testing.

## MVP Scope

## Must Have

- open local Markdown file or folder
- source editor
- select text and create thread
- reply to thread
- local sidecar persistence
- one terminal-first `margent` CLI path
- at least one agent path that can reply in-thread and propose a revision
- updated-document response handling
- diff preview
- accept or reject proposal
- resolve or reopen thread
- basic anchor recovery after edits

## Should Have

- `margent install`, `margent init`, and `margent doctor`
- agent cursor tracking so agents can continue conversations after user replies
- unresolved/resolved filters
- heading outline
- external file watch handling
- event log viewer or export

## Later

- rendered preview with source mapping
- multiple documents in one review session
- batch thread operations
- prompt templates per provider backend
- per-thread model instructions
- git integration
- collaboration sync
- plugin API

## Open Questions

- Should the app open folders only, or also support true single-file mode with the same UX?
- Should accepted proposals auto-resolve threads by default, or only suggest resolution?
- Should the CLI contract be limited to JSON stdout, or can it support markdown fences plus JSON extraction for advanced backends?
- Should agent sync run only when the user explicitly requests it, or can the app support a background polling mode later?
- How much fuzzy anchor recovery is acceptable before user trust drops?
- Should proposal review support partial acceptance in v1, or whole-proposal only?

## Recommended MVP Decisions

- Open both folders and single files, but normalize both into a workspace root
- Require explicit accept or reject on every proposal
- Prefer `updated_document` response mode in v1
- Auto-resolve only as a suggestion, not a default action
- Keep preview read-only in v1
- Prefer the `margent` CLI as the only Codex/Claude integration path
- Let `margent init` create any workspace-local provider skills or command scaffolding automatically

## First Build Order

1. Workspace and file model
2. Source editor with text selection
3. Thread persistence and sidebar
4. Anchor engine
5. Margent CLI skeleton and provider protocol
6. Proposal diff preview
7. Accept or reject flow
8. External file change handling
9. CLI install/init/doctor flow and polish

## Bottom Line

This product should be built as a native macOS review tool for Markdown, not as a Markdown format extension.

The key design decision is to keep comments, proposals, and AI interactions in a local sidecar layer while leaving the underlying Markdown plain and portable.

That is what makes CLI swapping, file interoperability, and long-term trust possible.
