import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { useThreadStore } from "../src/stores/threadStore";
import {
  COMMENT_DOCK_DEFAULT_WIDTH,
  COMMENT_DOCK_MAX_WIDTH,
  COMMENT_DOCK_MIN_WIDTH,
  useUiStore,
} from "../src/stores/uiStore";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import { createAnchor, defaultThreadTitle } from "../src/lib/anchor";
import { FileBrowser } from "../src/components/files/FileBrowser";
import type {
  AnchorRecord,
  EditorSelectionSnapshot,
  MessageRecord,
  ThreadRecord,
} from "../src/types/thread";
import type {
  DocumentPayload,
  DocumentSummary,
  HeadingIndexEntry,
} from "../src/types/workspace";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(__dirname, "..", "test-fixtures", "sample-workspace");
const README_CONTENT = readFileSync(join(FIXTURE_DIR, "README.md"), "utf8");

const stubAnchor: AnchorRecord = {
  quote: "The quick brown fox jumps over the lazy dog.",
  prefixContext: "sting Margent's review workflows.\n\n## Overview\n\n",
  suffixContext: " This sentence is used throughout the test suite",
  startOffsetUtf16: 99,
  endOffsetUtf16: 143,
  startLine: 7,
  startColumn: 1,
  endLine: 7,
  endColumn: 45,
  headingPath: ["Sample Project", "Overview"],
  blockFingerprint: "sha256:placeholder",
  baseContentHash: "sha256:placeholder",
  state: "attached",
  confidence: 1,
};

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    threadId: "t-1",
    authorType: "user",
    authorName: "Alice",
    agentId: null,
    adapterId: null,
    replyToMessageId: null,
    createdAt: "2026-01-01T00:00:00Z",
    body: "Hello",
    kind: "comment",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    schemaVersion: 1,
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    documentId: "doc-1",
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: "tester",
    title: "Test thread",
    tags: [],
    anchor: { ...stubAnchor },
    messages: [],
    linkedProposalIds: [],
    providerSessions: {},
    ...overrides,
  };
}

function makeDocumentSummary(
  overrides: Partial<DocumentSummary> = {},
): DocumentSummary {
  return {
    id: "doc-1",
    relativePath: "README.md",
    displayName: "README",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    currentContentHash: "sha256:abc123",
    lastKnownLineEnding: "lf",
    frontmatterMode: "none",
    wordCount: 100,
    headingIndex: [],
    ...overrides,
  };
}

function makeDocumentPayload(
  overrides: Partial<DocumentPayload> = {},
): DocumentPayload {
  const document = {
    ...makeDocumentSummary(),
    absolutePath: "/workspace/README.md",
    content: README_CONTENT,
    ...overrides,
  };

  return {
    ...document,
    version: document.version ?? {
      contentHash: document.currentContentHash,
      modifiedNs: null,
      size: new TextEncoder().encode(document.content).length,
    },
  };
}

// ===========================================================================
// 1. FileBrowser rendering
// ===========================================================================

describe("FileBrowser rendering", () => {
  const defaultProps = {
    activeRelativePath: null as string | null,
    documents: [] as DocumentSummary[],
    isCollapsed: false,
    isRefreshing: false,
    onCreateDocument: vi.fn(),
    onDeleteDocument: vi.fn(),
    onRefresh: vi.fn(),
    onRenameDocument: vi.fn(),
    onRevealDocument: vi.fn(),
    onSelectDocument: vi.fn(),
    onToggleCollapse: vi.fn(),
    rootPath: "/my/workspace",
  };

  it("renders document list from workspace documents", () => {
    const docs = [
      makeDocumentSummary({
        id: "doc-1",
        relativePath: "README.md",
        displayName: "README",
      }),
      makeDocumentSummary({
        id: "doc-2",
        relativePath: "notes/chapter1.md",
        displayName: "chapter1",
      }),
    ];

    render(createElement(FileBrowser, { ...defaultProps, documents: docs }));

    expect(screen.getByText("README")).toBeInTheDocument();
    expect(screen.getByText("chapter1")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("notes/chapter1.md")).toBeInTheDocument();
  });

  it("highlights the active document", () => {
    const docs = [
      makeDocumentSummary({
        id: "doc-1",
        relativePath: "README.md",
        displayName: "README",
      }),
      makeDocumentSummary({
        id: "doc-2",
        relativePath: "notes.md",
        displayName: "Notes",
      }),
    ];

    render(
      createElement(FileBrowser, {
        ...defaultProps,
        documents: docs,
        activeRelativePath: "README.md",
      }),
    );

    const activeButton = screen.getByText("README").closest("button");
    const inactiveButton = screen.getByText("Notes").closest("button");

    expect(activeButton?.className).toContain("active");
    expect(inactiveButton?.className).not.toContain("active");
  });

  it("calls onSelectDocument when a file is clicked", () => {
    const onSelectDocument = vi.fn();
    const docs = [
      makeDocumentSummary({
        id: "doc-1",
        relativePath: "README.md",
        displayName: "README",
      }),
    ];

    render(
      createElement(FileBrowser, {
        ...defaultProps,
        documents: docs,
        onSelectDocument,
      }),
    );

    const button = screen.getByText("README").closest("button")!;
    fireEvent.click(button);

    expect(onSelectDocument).toHaveBeenCalledTimes(1);
    expect(onSelectDocument).toHaveBeenCalledWith("README.md");
  });

  it("creates a new Markdown file from the header action", () => {
    const onCreateDocument = vi.fn();

    render(
      createElement(FileBrowser, {
        ...defaultProps,
        onCreateDocument,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "New File" }));
    fireEvent.change(screen.getByLabelText("Create Markdown file name"), {
      target: { value: "drafts/new-note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreateDocument).toHaveBeenCalledWith("drafts/new-note.md");
  });

  it("does not reselect the new-file name after each typed character", () => {
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");

    try {
      render(createElement(FileBrowser, { ...defaultProps }));

      fireEvent.click(screen.getByRole("button", { name: "New File" }));

      const input = screen.getByLabelText("Create Markdown file name");
      expect(selectSpy).toHaveBeenCalledTimes(1);

      fireEvent.change(input, { target: { value: "a" } });

      expect(selectSpy).toHaveBeenCalledTimes(1);
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("exposes row actions for reveal, rename, and delete", () => {
    const onDeleteDocument = vi.fn();
    const onRenameDocument = vi.fn();
    const onRevealDocument = vi.fn();
    const docs = [
      makeDocumentSummary({
        id: "doc-1",
        relativePath: "README.md",
        displayName: "README",
      }),
    ];

    render(
      createElement(FileBrowser, {
        ...defaultProps,
        documents: docs,
        onDeleteDocument,
        onRenameDocument,
        onRevealDocument,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Rename Markdown file name"), {
      target: { value: "renamed" },
    });
    fireEvent.submit(screen.getByLabelText("Rename Markdown file name").closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Confirm delete file" })).getByRole("button", {
        name: "Delete",
      }),
    );

    expect(onRevealDocument).toHaveBeenCalledWith("README.md");
    expect(onRenameDocument).toHaveBeenCalledWith("README.md", "renamed.md");
    expect(onDeleteDocument).toHaveBeenCalledWith("README.md");
  });

  it("handles command-driven create and rename requests with inline inputs", () => {
    const onCreateDocument = vi.fn();
    const onRenameDocument = vi.fn();
    const docs = [
      makeDocumentSummary({
        id: "doc-1",
        relativePath: "README.md",
        displayName: "README",
      }),
    ];
    const { rerender } = render(
      createElement(FileBrowser, {
        ...defaultProps,
        actionRequest: { id: 1, kind: "create" },
        documents: docs,
        onCreateDocument,
        onRenameDocument,
      }),
    );

    fireEvent.change(screen.getByLabelText("Create Markdown file name"), {
      target: { value: "notes/today" },
    });
    fireEvent.submit(screen.getByLabelText("Create Markdown file name").closest("form")!);

    expect(onCreateDocument).toHaveBeenCalledWith("notes/today.md");

    rerender(
      createElement(FileBrowser, {
        ...defaultProps,
        actionRequest: { id: 2, kind: "rename", relativePath: "README.md" },
        documents: docs,
        onCreateDocument,
        onRenameDocument,
      }),
    );

    fireEvent.change(screen.getByLabelText("Rename Markdown file name"), {
      target: { value: "README-renamed.md" },
    });
    fireEvent.submit(screen.getByLabelText("Rename Markdown file name").closest("form")!);

    expect(onRenameDocument).toHaveBeenCalledWith("README.md", "README-renamed.md");
  });

  it("shows empty state when no documents", () => {
    render(createElement(FileBrowser, { ...defaultProps, documents: [] }));

    expect(
      screen.getByText("No Markdown files were found in this workspace yet."),
    ).toBeInTheDocument();
  });

  it("exposes the root path as the rail header tooltip", () => {
    render(
      createElement(FileBrowser, {
        ...defaultProps,
        rootPath: "/home/user/my-project",
      }),
    );

    expect(document.querySelector(".panel-header")).toHaveAttribute(
      "title",
      "/home/user/my-project",
    );
  });

  it("shows document count in the rail header", () => {
    const docs = [
      makeDocumentSummary({ id: "doc-1", relativePath: "a.md", displayName: "A" }),
      makeDocumentSummary({ id: "doc-2", relativePath: "b.md", displayName: "B" }),
      makeDocumentSummary({ id: "doc-3", relativePath: "c.md", displayName: "C" }),
    ];

    render(
      createElement(FileBrowser, { ...defaultProps, documents: docs }),
    );

    expect(screen.getByText("3 markdown files")).toBeInTheDocument();
  });

  it("renders a collapsed workspace rail and allows reopening", () => {
    const onToggleCollapse = vi.fn();

    render(
      createElement(FileBrowser, {
        ...defaultProps,
        documents: [
          makeDocumentSummary({ id: "doc-1", relativePath: "a.md", displayName: "A" }),
        ],
        isCollapsed: true,
        onToggleCollapse,
      }),
    );

    expect(screen.getByRole("button", { name: "Show files pane" })).toBeInTheDocument();
    expect(screen.queryByText("A")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show files pane" }));

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2. Thread selection state flow
// ===========================================================================

describe("Thread selection state flow", () => {
  beforeEach(() => {
    useThreadStore.getState().reset();
  });

  it("selecting a thread updates selectedThreadId and increments selectionRevision", () => {
    const revBefore = useThreadStore.getState().selectionRevision;

    useThreadStore.getState().selectThread("thread-abc");

    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBe("thread-abc");
    expect(state.selectionRevision).toBe(revBefore + 1);
  });

  it("selecting a thread that already has messages does not need loadThread", () => {
    // This tests the logic from DocumentEditor's useEffect:
    // if selectedThreadSummary.messages.length > 0, threadDetail is set directly
    const msg = makeMessage({ id: "msg-1", threadId: "t-1", body: "Already loaded" });
    const thread = makeThread({ id: "t-1", messages: [msg] });

    useThreadStore.getState().setThreads([thread]);
    useThreadStore.getState().selectThread("t-1");

    const state = useThreadStore.getState();
    const selectedThread = state.threads.find((t) => t.id === state.selectedThreadId);

    // Thread has messages — the DocumentEditor useEffect would skip loadThread
    expect(selectedThread).toBeDefined();
    expect(selectedThread!.messages.length).toBeGreaterThan(0);
  });

  it("selecting a thread with empty messages would trigger loadThread", () => {
    // This tests the logic branch: if selectedThreadSummary.messages.length === 0,
    // the useEffect calls loadThreadRef.current(selectedThreadId)
    const thread = makeThread({ id: "t-empty", messages: [] });

    useThreadStore.getState().setThreads([thread]);
    useThreadStore.getState().selectThread("t-empty");

    const state = useThreadStore.getState();
    const selectedThread = state.threads.find((t) => t.id === state.selectedThreadId);

    expect(selectedThread).toBeDefined();
    expect(selectedThread!.messages).toHaveLength(0);
    // In DocumentEditor, this condition would trigger:
    // void loadThreadRef.current(selectedThreadId)
  });

  it("deselecting (null) clears selection", () => {
    useThreadStore.getState().selectThread("t-1");
    expect(useThreadStore.getState().selectedThreadId).toBe("t-1");

    useThreadStore.getState().selectThread(null);

    expect(useThreadStore.getState().selectedThreadId).toBeNull();
  });

  it("selecting a thread that does not exist in the list is handled gracefully", () => {
    const t1 = makeThread({ id: "t-1" });
    useThreadStore.getState().setThreads([t1]);

    // Select a thread ID that doesn't exist in the thread list
    useThreadStore.getState().selectThread("t-nonexistent");

    const state = useThreadStore.getState();
    // The store sets selectedThreadId regardless — the DocumentEditor's useEffect
    // checks: if (selectedThreadId && !selectedThreadSummary) { onThreadSelect(null); }
    expect(state.selectedThreadId).toBe("t-nonexistent");

    // Simulate what DocumentEditor does: find the thread in the list
    const selectedThreadSummary = state.threads.find(
      (t) => t.id === state.selectedThreadId,
    );
    expect(selectedThreadSummary).toBeUndefined();
    // DocumentEditor would call onThreadSelect(null) in this case
  });

  it("re-selecting the same thread still increments selectionRevision", () => {
    useThreadStore.getState().selectThread("t-1");
    const rev1 = useThreadStore.getState().selectionRevision;

    useThreadStore.getState().selectThread("t-1");
    const rev2 = useThreadStore.getState().selectionRevision;

    expect(rev2).toBe(rev1 + 1);
  });
});

// ===========================================================================
// 3. Workspace store state transitions
// ===========================================================================

describe("Workspace store state transitions", () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset();
  });

  it("setting activeDocument clears editor dirty state", () => {
    const doc = makeDocumentPayload({ content: "# Hello World\n\nSome content." });
    useWorkspaceStore.getState().setIsEditorDirty(true);

    useWorkspaceStore.getState().setActiveDocument(doc);

    const state = useWorkspaceStore.getState();
    expect(state.activeDocument).toBe(doc);
    expect(state.isEditorDirty).toBe(false);
  });

  it("setting isEditorDirty marks the active editor session as dirty", () => {
    const doc = makeDocumentPayload({ content: "Original content" });
    useWorkspaceStore.getState().setActiveDocument(doc);

    expect(useWorkspaceStore.getState().isEditorDirty).toBe(false);

    useWorkspaceStore.getState().setIsEditorDirty(true);

    const state = useWorkspaceStore.getState();
    expect(state.isEditorDirty).toBe(true);
    expect(state.activeDocument?.content).toBe("Original content");
  });

  it("setting a new activeDocument clears pendingExternalDocument", () => {
    const pendingDoc = makeDocumentPayload({
      id: "doc-pending",
      content: "Pending content",
    });
    useWorkspaceStore.getState().setPendingExternalDocument(pendingDoc);
    expect(useWorkspaceStore.getState().pendingExternalDocument).toBe(pendingDoc);

    const newDoc = makeDocumentPayload({
      id: "doc-new",
      content: "New content",
    });
    useWorkspaceStore.getState().setActiveDocument(newDoc);

    const state = useWorkspaceStore.getState();
    expect(state.pendingExternalDocument).toBeNull();
    expect(state.activeDocument!.id).toBe("doc-new");
  });

  it("status transitions: idle -> loading -> ready", () => {
    expect(useWorkspaceStore.getState().status).toBe("idle");

    useWorkspaceStore.getState().setStatus("loading");
    expect(useWorkspaceStore.getState().status).toBe("loading");

    useWorkspaceStore.getState().setStatus("ready");
    expect(useWorkspaceStore.getState().status).toBe("ready");
  });

  it("reset clears all state", () => {
    const doc = makeDocumentPayload({ content: "Some content" });
    useWorkspaceStore.getState().setActiveDocument(doc);
    useWorkspaceStore.getState().setIsEditorDirty(true);
    useWorkspaceStore.getState().setStatus("ready");
    useWorkspaceStore.getState().setErrorMessage("An error occurred");
    useWorkspaceStore.getState().setIsSaving(true);
    useWorkspaceStore.getState().setWorkspace({
      rootPath: "/workspace",
      openedPath: null,
      mdreviewPath: "/workspace/.mdreview",
      selectedRelativePath: null,
      documents: [],
    });

    useWorkspaceStore.getState().reset();

    const state = useWorkspaceStore.getState();
    expect(state.activeDocument).toBeNull();
    expect(state.isEditorDirty).toBe(false);
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBeNull();
    expect(state.isSaving).toBe(false);
    expect(state.workspace).toBeNull();
    expect(state.pendingExternalDocument).toBeNull();
  });

  it("setting activeDocument to null clears editor dirty state", () => {
    const doc = makeDocumentPayload({ content: "Content here" });
    useWorkspaceStore.getState().setActiveDocument(doc);
    useWorkspaceStore.getState().setIsEditorDirty(true);

    useWorkspaceStore.getState().setActiveDocument(null);

    const state = useWorkspaceStore.getState();
    expect(state.activeDocument).toBeNull();
    expect(state.isEditorDirty).toBe(false);
  });
});

// ===========================================================================
// 4. UI layout store state transitions
// ===========================================================================

describe("UI layout store state transitions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.getState().reset();
  });

  it("toggles workspace pane collapse and persists the new state", () => {
    expect(useUiStore.getState().isWorkspacePaneCollapsed).toBe(false);

    useUiStore.getState().toggleWorkspacePane();

    expect(useUiStore.getState().isWorkspacePaneCollapsed).toBe(true);
    expect(window.localStorage.getItem("margent:ui")).toContain(
      '"isWorkspacePaneCollapsed":true',
    );
  });

  it("stores the selected editor mode", () => {
    expect(useUiStore.getState().editorMode).toBe("rendered");

    useUiStore.getState().setEditorMode("rendered");

    expect(useUiStore.getState().editorMode).toBe("rendered");
    expect(window.localStorage.getItem("margent:ui")).toContain('"editorMode":"rendered"');
  });

  it("toggles focus mode and persists the new state", () => {
    expect(useUiStore.getState().isFocusModeEnabled).toBe(false);

    useUiStore.getState().toggleFocusMode();

    expect(useUiStore.getState().isFocusModeEnabled).toBe(true);
    expect(window.localStorage.getItem("margent:ui")).toContain('"isFocusModeEnabled":true');

    useUiStore.getState().setFocusModeEnabled(false);

    expect(useUiStore.getState().isFocusModeEnabled).toBe(false);
    expect(window.localStorage.getItem("margent:ui")).toContain('"isFocusModeEnabled":false');
  });

  it("keeps the document outline hidden by default and persists visibility changes", () => {
    expect(useUiStore.getState().isDocumentOutlineVisible).toBe(false);

    useUiStore.getState().toggleDocumentOutline();

    expect(useUiStore.getState().isDocumentOutlineVisible).toBe(true);
    expect(window.localStorage.getItem("margent:ui")).toContain(
      '"isDocumentOutlineVisible":true',
    );

    useUiStore.getState().setDocumentOutlineVisible(false);

    expect(useUiStore.getState().isDocumentOutlineVisible).toBe(false);
    expect(window.localStorage.getItem("margent:ui")).toContain(
      '"isDocumentOutlineVisible":false',
    );
  });

  it("stores the selected theme mode", () => {
    expect(useUiStore.getState().themeMode).toBe("system");

    useUiStore.getState().setThemeMode("dark");

    expect(useUiStore.getState().themeMode).toBe("dark");
    expect(window.localStorage.getItem("margent:ui")).toContain('"themeMode":"dark"');

    useUiStore.getState().setThemeMode("light");

    expect(useUiStore.getState().themeMode).toBe("light");
    expect(window.localStorage.getItem("margent:ui")).toContain('"themeMode":"light"');
  });

  it("stores and clamps the comment dock width", () => {
    expect(useUiStore.getState().commentDockWidth).toBe(COMMENT_DOCK_DEFAULT_WIDTH);

    useUiStore.getState().setCommentDockWidth(620);

    expect(useUiStore.getState().commentDockWidth).toBe(620);
    expect(window.localStorage.getItem("margent:ui")).toContain('"commentDockWidth":620');

    useUiStore.getState().setCommentDockWidth(COMMENT_DOCK_MAX_WIDTH + 100);
    expect(useUiStore.getState().commentDockWidth).toBe(COMMENT_DOCK_MAX_WIDTH);

    useUiStore.getState().setCommentDockWidth(COMMENT_DOCK_MIN_WIDTH - 100);
    expect(useUiStore.getState().commentDockWidth).toBe(COMMENT_DOCK_MIN_WIDTH);
  });

  it("reset clears layout state and persisted storage", () => {
    useUiStore.getState().setEditorMode("rendered");
    useUiStore.getState().setCommentDockWidth(620);
    useUiStore.getState().setDocumentOutlineVisible(true);
    useUiStore.getState().setFocusModeEnabled(true);
    useUiStore.getState().setWorkspacePaneCollapsed(true);

    useUiStore.getState().reset();

    expect(useUiStore.getState().commentDockWidth).toBe(COMMENT_DOCK_DEFAULT_WIDTH);
    expect(useUiStore.getState().editorMode).toBe("rendered");
    expect(useUiStore.getState().isDocumentOutlineVisible).toBe(false);
    expect(useUiStore.getState().isFocusModeEnabled).toBe(false);
    expect(useUiStore.getState().isWorkspacePaneCollapsed).toBe(false);
    expect(window.localStorage.getItem("margent:ui")).toBeNull();
  });
});

// ===========================================================================
// 5. Thread-document coordination
// ===========================================================================

describe("Thread-document coordination", () => {
  beforeEach(() => {
    useThreadStore.getState().reset();
    useWorkspaceStore.getState().reset();
  });

  it("threads are filtered to activeDocument.id by checking thread.documentId", () => {
    const threadForDoc1 = makeThread({
      id: "t-1",
      documentId: "doc-1",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const threadForDoc2 = makeThread({
      id: "t-2",
      documentId: "doc-2",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    useThreadStore.getState().setThreads([threadForDoc1, threadForDoc2]);

    const activeDocId = "doc-1";
    const threadsForActiveDoc = useThreadStore
      .getState()
      .threads.filter((t) => t.documentId === activeDocId);

    expect(threadsForActiveDoc).toHaveLength(1);
    expect(threadsForActiveDoc[0].id).toBe("t-1");
  });

  it("when activeDocument changes, thread selection should be cleared", () => {
    // In the app, useThreads resets the store when activeDocument changes.
    // We simulate that: selecting a thread, then resetting the thread store
    // (which is what happens in useThreads when activeDocument changes).
    const thread = makeThread({ id: "t-1" });
    useThreadStore.getState().setThreads([thread]);
    useThreadStore.getState().selectThread("t-1");
    expect(useThreadStore.getState().selectedThreadId).toBe("t-1");

    // Simulating activeDocument change triggers store.reset() in useThreads
    useThreadStore.getState().reset();

    expect(useThreadStore.getState().selectedThreadId).toBeNull();
    expect(useThreadStore.getState().threads).toEqual([]);
  });

  it("thread creation builds correct anchor from selection data", async () => {
    const doc = makeDocumentPayload({
      content: README_CONTENT,
      headingIndex: [
        { depth: 1, text: "Sample Project", line: 1 },
        { depth: 2, text: "Overview", line: 5 },
        { depth: 2, text: "Features", line: 9 },
      ],
    });

    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: 99,
      endOffsetUtf16: 143,
      startLine: 7,
      startColumn: 1,
      endLine: 7,
      endColumn: 45,
      quote: "The quick brown fox jumps over the lazy dog.",
    };

    const anchor = await createAnchor(doc, README_CONTENT, selection);

    expect(anchor.quote).toBe("The quick brown fox jumps over the lazy dog.");
    expect(anchor.startOffsetUtf16).toBe(99);
    expect(anchor.endOffsetUtf16).toBe(143);
    expect(anchor.startLine).toBe(7);
    expect(anchor.startColumn).toBe(1);
    expect(anchor.state).toBe("attached");
    expect(anchor.confidence).toBe(1);
    expect(anchor.headingPath).toEqual(["Sample Project", "Overview"]);
  });

  it("default thread title generation from quoted text", () => {
    // Short quote: used as-is
    expect(defaultThreadTitle("Hello world")).toBe("Hello world");

    // Long quote: truncated at 56 chars (53 + "...")
    const longQuote =
      "This is a very long quoted text that definitely exceeds the fifty-six character maximum limit for thread titles";
    const title = defaultThreadTitle(longQuote);
    expect(title.length).toBeLessThanOrEqual(56);
    expect(title).toBe(`${longQuote.slice(0, 53)}...`);

    // Empty quote: fallback
    expect(defaultThreadTitle("")).toBe("New thread");
    expect(defaultThreadTitle("   ")).toBe("New thread");

    // Whitespace normalization
    expect(defaultThreadTitle("hello   \n   world")).toBe("hello world");
  });
});

// ===========================================================================
// 5. Anchor creation
// ===========================================================================

describe("Anchor creation", () => {
  const headingIndex: HeadingIndexEntry[] = [
    { depth: 1, text: "Sample Project", line: 1 },
    { depth: 2, text: "Overview", line: 5 },
    { depth: 2, text: "Features", line: 9 },
    { depth: 3, text: "Thread Anchoring", line: 13 },
    { depth: 3, text: "External Editing", line: 17 },
    { depth: 2, text: "Conclusion", line: 21 },
  ];

  const fixtureDoc = makeDocumentPayload({
    content: README_CONTENT,
    headingIndex,
  });

  it("creates anchor with correct quote, offsets, line/column numbers", async () => {
    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: 99,
      endOffsetUtf16: 143,
      startLine: 7,
      startColumn: 1,
      endLine: 7,
      endColumn: 45,
      quote: "The quick brown fox jumps over the lazy dog.",
    };

    const anchor = await createAnchor(fixtureDoc, README_CONTENT, selection);

    expect(anchor.quote).toBe("The quick brown fox jumps over the lazy dog.");
    expect(anchor.startOffsetUtf16).toBe(99);
    expect(anchor.endOffsetUtf16).toBe(143);
    expect(anchor.startLine).toBe(7);
    expect(anchor.startColumn).toBe(1);
    expect(anchor.endLine).toBe(7);
    expect(anchor.endColumn).toBe(45);
  });

  it("extracts correct heading path from document headingIndex", async () => {
    // Selection on line 7 is under "Sample Project" > "Overview"
    const selectionOverview: EditorSelectionSnapshot = {
      startOffsetUtf16: 99,
      endOffsetUtf16: 143,
      startLine: 7,
      startColumn: 1,
      endLine: 7,
      endColumn: 45,
      quote: "The quick brown fox jumps over the lazy dog.",
    };

    const anchorOverview = await createAnchor(
      fixtureDoc,
      README_CONTENT,
      selectionOverview,
    );
    expect(anchorOverview.headingPath).toEqual(["Sample Project", "Overview"]);

    // Selection on line 15 is under "Sample Project" > "Features" > "Thread Anchoring"
    const selectionAnchoring: EditorSelectionSnapshot = {
      startOffsetUtf16: 427,
      endOffsetUtf16: 465,
      startLine: 15,
      startColumn: 1,
      endLine: 15,
      endColumn: 39,
      quote: "Anchors track the original quoted text",
    };

    const anchorAnchoring = await createAnchor(
      fixtureDoc,
      README_CONTENT,
      selectionAnchoring,
    );
    expect(anchorAnchoring.headingPath).toEqual([
      "Sample Project",
      "Features",
      "Thread Anchoring",
    ]);
  });

  it("computes prefix/suffix context (48 chars each)", async () => {
    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: 99,
      endOffsetUtf16: 143,
      startLine: 7,
      startColumn: 1,
      endLine: 7,
      endColumn: 45,
      quote: "The quick brown fox jumps over the lazy dog.",
    };

    const anchor = await createAnchor(fixtureDoc, README_CONTENT, selection);

    // CONTEXT_RADIUS is 48, so prefix = content.slice(max(0, 99-48), 99) = content.slice(51, 99)
    expect(anchor.prefixContext).toBe(README_CONTENT.slice(51, 99));
    expect(anchor.prefixContext.length).toBeLessThanOrEqual(48);

    // suffix = content.slice(143, min(content.length, 143+48)) = content.slice(143, 191)
    expect(anchor.suffixContext).toBe(README_CONTENT.slice(143, 191));
    expect(anchor.suffixContext.length).toBeLessThanOrEqual(48);
  });

  it("sets initial state to 'attached' and confidence to 1.0", async () => {
    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: 99,
      endOffsetUtf16: 143,
      startLine: 7,
      startColumn: 1,
      endLine: 7,
      endColumn: 45,
      quote: "The quick brown fox jumps over the lazy dog.",
    };

    const anchor = await createAnchor(fixtureDoc, README_CONTENT, selection);

    expect(anchor.state).toBe("attached");
    expect(anchor.confidence).toBe(1.0);
  });

  it("generates SHA-256 hashes for blockFingerprint and baseContentHash", async () => {
    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: 99,
      endOffsetUtf16: 143,
      startLine: 7,
      startColumn: 1,
      endLine: 7,
      endColumn: 45,
      quote: "The quick brown fox jumps over the lazy dog.",
    };

    const anchor = await createAnchor(fixtureDoc, README_CONTENT, selection);

    expect(anchor.blockFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(anchor.baseContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("handles selection at the start of the document (prefix clamped to 0)", async () => {
    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: 2,
      endOffsetUtf16: 16,
      startLine: 1,
      startColumn: 3,
      endLine: 1,
      endColumn: 17,
      quote: "Sample Project",
    };

    const anchor = await createAnchor(fixtureDoc, README_CONTENT, selection);

    // Prefix starts at max(0, 2-48) = 0
    expect(anchor.prefixContext).toBe(README_CONTENT.slice(0, 2));
    expect(anchor.prefixContext.length).toBe(2);
  });

  it("emits footnote metadata for conservative footnote-token selections", async () => {
    const content = "Paragraph with ref [^alpha].\n\n[^alpha]: Footnote definition\n";
    const footnoteDoc = makeDocumentPayload({
      content,
      headingIndex: [],
    });
    const tokenStart = content.indexOf("[^alpha]");
    const tokenEnd = tokenStart + "[^alpha]".length;
    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: tokenStart,
      endOffsetUtf16: tokenEnd,
      startLine: 1,
      startColumn: tokenStart + 1,
      endLine: 1,
      endColumn: tokenEnd + 1,
      quote: "[^alpha]",
    };

    const anchor = await createAnchor(footnoteDoc, content, selection);

    expect(anchor.kind).toBe("footnote_reference");
    expect(anchor.footnote).toEqual({
      label: "alpha",
      occurrence: 1,
    });
  });

  it("falls back to text_span for broader sentence selections around a footnote reference", async () => {
    const content = "Paragraph with ref [^alpha].\n\n[^alpha]: Footnote definition\n";
    const footnoteDoc = makeDocumentPayload({
      content,
      headingIndex: [],
    });
    const selection: EditorSelectionSnapshot = {
      startOffsetUtf16: 0,
      endOffsetUtf16: "Paragraph with ref [^alpha].".length,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: "Paragraph with ref [^alpha].".length + 1,
      quote: "Paragraph with ref [^alpha].",
    };

    const anchor = await createAnchor(footnoteDoc, content, selection);

    expect(anchor.kind).toBe("text_span");
    expect(anchor.footnote).toBeNull();
  });
});
