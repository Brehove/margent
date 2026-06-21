import { createElement } from "react";
import { render, waitFor, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { watch, type WatchEvent } from "@tauri-apps/plugin-fs";
import { useReviewData } from "../src/hooks/useReviewData";
import { useThreads } from "../src/hooks/useThreads";
import {
  createMarkdownFile,
  deleteMarkdownFile,
  renameMarkdownFile,
  saveCurrentDocument,
  useWorkspaceEffects,
} from "../src/hooks/useWorkspace";
import { useThreadStore } from "../src/stores/threadStore";
import { useReviewDataStore } from "../src/stores/reviewDataStore";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import type { ProposalRecord } from "../src/types/proposal";
import type { AnchorRecord, ThreadRecord } from "../src/types/thread";
import type { DocumentPayload, WorkspaceSnapshot } from "../src/types/workspace";

const invokeMock = vi.mocked(invoke);
const isTauriMock = vi.mocked(isTauri);
const watchMock = vi.mocked(watch);
const SETTLED_DOCUMENT_REFRESH_DELAY_MS = 350;
const SETTLED_REVIEW_REFRESH_DELAY_MS = 350;

const baseAnchor: AnchorRecord = {
  quote: "Alpha beta gamma.",
  prefixContext: "",
  suffixContext: "",
  startOffsetUtf16: 0,
  endOffsetUtf16: 17,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 18,
  headingPath: [],
  blockFingerprint: "sha256:block",
  baseContentHash: "sha256:base",
  state: "attached",
  confidence: 1,
};

function makeDocument(overrides: Partial<DocumentPayload> = {}): DocumentPayload {
  const document = {
    schemaVersion: 1,
    id: "doc-1",
    relativePath: "test.md",
    absolutePath: "/tmp/margent-watch-test/test.md",
    displayName: "test.md",
    createdAt: "2026-03-19T00:00:00Z",
    updatedAt: "2026-03-19T00:00:00Z",
    currentContentHash: "sha256:old",
    lastKnownLineEnding: "lf",
    frontmatterMode: "none",
    wordCount: 3,
    headingIndex: [],
    content: "# Watch Test\n\nAlpha beta gamma.\n",
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

function makeWorkspace(document: DocumentPayload | DocumentPayload[]): WorkspaceSnapshot {
  const documents = Array.isArray(document) ? document : [document];
  const selectedDocument = documents[0] ?? null;

  return {
    rootPath: "/tmp/margent-watch-test",
    openedPath: null,
    mdreviewPath: "/tmp/margent-watch-test/.mdreview",
    selectedRelativePath: selectedDocument?.relativePath ?? null,
    documents: documents.map((entry) => ({
      id: entry.id,
      relativePath: entry.relativePath,
      displayName: entry.displayName,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      currentContentHash: entry.currentContentHash,
      lastKnownLineEnding: entry.lastKnownLineEnding,
      frontmatterMode: entry.frontmatterMode,
      wordCount: entry.wordCount,
      headingIndex: entry.headingIndex,
    })),
  };
}

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    schemaVersion: 1,
    id: "thread-1",
    documentId: "doc-1",
    status: "open",
    createdAt: "2026-03-19T00:00:00Z",
    updatedAt: "2026-03-19T00:00:00Z",
    createdBy: "user",
    title: "Thread",
    tags: [],
    anchor: { ...baseAnchor },
    messages: [],
    linkedProposalIds: [],
    providerSessions: {},
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    schemaVersion: 1,
    id: "proposal-1",
    documentId: "doc-1",
    threadIds: ["thread-1"],
    adapterId: "codex",
    createdAt: "2026-03-19T00:00:00Z",
    updatedAt: "2026-03-19T00:00:00Z",
    status: "pending",
    baseContentHash: "sha256:old",
    responseMode: "updated_document",
    summary: "Proposal",
    assistantMessage: "Updated text.",
    updatedDocumentText: "Updated text.",
    unifiedDiff: null,
    computedDiff: "",
    warnings: [],
    resolveThreadIds: [],
    stderr: null,
    errorMessage: null,
    ...overrides,
  };
}

function WorkspaceEffectsHarness() {
  useWorkspaceEffects();
  return null;
}

function ThreadsHarness({
  activeDocument,
  workspace,
}: {
  activeDocument: DocumentPayload | null;
  workspace: WorkspaceSnapshot | null;
}) {
  useReviewData({ activeDocument, workspace });
  useThreads({ activeDocument, workspace });
  return null;
}

function makeWatchEvent(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    type: {
      modify: {
        kind: "data",
        mode: "content",
      },
    },
    paths: ["/tmp/margent-watch-test/test.md"],
    attrs: {},
    ...overrides,
  };
}

function captureWorkspaceWatchers() {
  let documentWatchCallback: (() => void) | null = null;
  let workspaceWatchCallback: ((event?: WatchEvent) => void) | null = null;

  watchMock.mockImplementation(async (_path, callback, options) => {
    if (options?.recursive) {
      workspaceWatchCallback = (event = makeWatchEvent()) => callback(event);
    } else {
      documentWatchCallback = () => callback(makeWatchEvent());
    }

    return vi.fn();
  });

  return {
    triggerDocumentWatch: () => documentWatchCallback?.(),
    triggerWorkspaceWatch: (event?: WatchEvent) => workspaceWatchCallback?.(event),
  };
}

beforeEach(() => {
  cleanup();
  invokeMock.mockReset();
  isTauriMock.mockReset();
  watchMock.mockReset();
  useWorkspaceStore.getState().reset();
  useThreadStore.getState().reset();
  useReviewDataStore.getState().reset();
  isTauriMock.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe("workspace watcher behavior", () => {
  it("refreshes the active document when an external change arrives and the editor is clean", async () => {
    const initialDocument = makeDocument();
    const updatedDocument = makeDocument({
      content: "# Watch Test\n\nAlpha beta gamma delta epsilon zeta.\n",
      currentContentHash: "sha256:new",
      updatedAt: "2026-03-19T00:01:00Z",
      wordCount: 6,
    });
    const workspace = makeWorkspace(initialDocument);
    const watchers = captureWorkspaceWatchers();
    let hasExternalDocumentChange = false;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "check_document_update") {
        return hasExternalDocumentChange && args.knownContentHash === "sha256:old"
          ? updatedDocument
          : null;
      }

      return null;
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));
    expect(useWorkspaceStore.getState().activeDocument?.currentContentHash).toBe("sha256:old");

    await act(async () => {
      hasExternalDocumentChange = true;
      watchers.triggerDocumentWatch();
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().activeDocument?.currentContentHash).toBe("sha256:new"),
    );
    expect(useWorkspaceStore.getState().pendingExternalDocument).toBeNull();
  });

  it("stores a pending external document instead of replacing the active document when dirty", async () => {
    const initialDocument = makeDocument();
    const updatedDocument = makeDocument({
      content: "# Watch Test\n\nExternally changed.\n",
      currentContentHash: "sha256:external",
      updatedAt: "2026-03-19T00:02:00Z",
      wordCount: 2,
    });
    const workspace = makeWorkspace(initialDocument);
    const watchers = captureWorkspaceWatchers();
    let hasExternalDocumentChange = false;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "check_document_update") {
        return hasExternalDocumentChange && args.knownContentHash === "sha256:old"
          ? updatedDocument
          : null;
      }

      return null;
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      isEditorDirty: true,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      hasExternalDocumentChange = true;
      watchers.triggerDocumentWatch();
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().pendingExternalDocument?.currentContentHash).toBe(
        "sha256:external",
      ),
    );
    expect(useWorkspaceStore.getState().activeDocument?.currentContentHash).toBe("sha256:old");
  });

  it("applies a pending external document once the editor becomes clean", async () => {
    const initialDocument = makeDocument();
    const updatedDocument = makeDocument({
      content: "# Watch Test\n\nExternally changed.\n",
      currentContentHash: "sha256:external",
      updatedAt: "2026-03-19T00:02:00Z",
      wordCount: 2,
    });
    const workspace = makeWorkspace(initialDocument);

    let hasExternalDocumentChange = false;
    const watchers = captureWorkspaceWatchers();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command !== "check_document_update") {
        return null;
      }

      if (!hasExternalDocumentChange) {
        return null;
      }

      return args.knownContentHash === "sha256:old" ? updatedDocument : null;
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      isEditorDirty: true,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      hasExternalDocumentChange = true;
      watchers.triggerDocumentWatch();
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().pendingExternalDocument?.currentContentHash).toBe(
        "sha256:external",
      ),
    );

    act(() => {
      useWorkspaceStore.getState().setIsEditorDirty(false);
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().activeDocument?.currentContentHash).toBe(
        "sha256:external",
      ),
    );
    expect(useWorkspaceStore.getState().pendingExternalDocument).toBeNull();
  });

  it("performs a settled follow-up refresh so atomic document rewrites are not missed", async () => {
    const initialDocument = makeDocument();
    const updatedDocument = makeDocument({
      content: "# Watch Test\n\nUpdated from external write.\n",
      currentContentHash: "sha256:external-settled",
      updatedAt: "2026-03-19T00:03:00Z",
      wordCount: 4,
    });
    const workspace = makeWorkspace(initialDocument);
    const watchers = captureWorkspaceWatchers();
    let externalChangeVisible = false;

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command !== "check_document_update") {
        return null;
      }

      return externalChangeVisible && args.knownContentHash === "sha256:old"
        ? updatedDocument
        : null;
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      window.setTimeout(() => {
        externalChangeVisible = true;
      }, 100);
      watchers.triggerDocumentWatch();
    });

    expect(useWorkspaceStore.getState().activeDocument?.currentContentHash).toBe("sha256:old");

    await act(async () => {
      await new Promise((resolve) =>
        window.setTimeout(resolve, SETTLED_DOCUMENT_REFRESH_DELAY_MS + 75),
      );
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().activeDocument?.currentContentHash).toBe(
        "sha256:external-settled",
      ),
    );
  });

  it("suppresses document watcher refresh while a save is in progress", async () => {
    const initialDocument = makeDocument();
    const workspace = makeWorkspace(initialDocument);
    const watchers = captureWorkspaceWatchers();
    invokeMock.mockImplementation(async (command) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      return null;
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock.mock.calls.length).toBeGreaterThanOrEqual(2));

    act(() => {
      useWorkspaceStore.getState().setIsSaving(true);
    });

    await act(async () => {
      await Promise.resolve();
    });
    invokeMock.mockClear();

    await act(async () => {
      watchers.triggerDocumentWatch();
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("saves provided content even before the global dirty flag catches up", async () => {
    const initialDocument = makeDocument({
      content: "# Watch Test\n\nOriginal.\n",
      currentContentHash: "sha256:old",
    });
    const savedDocument = makeDocument({
      content: "# Watch Test\n\nOriginal plus immediate edit.\n",
      currentContentHash: "sha256:saved",
      updatedAt: "2026-03-19T00:04:00Z",
      wordCount: 5,
    });
    const workspace = makeWorkspace(initialDocument);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "save_document_if_current") {
        expect(args).toEqual({
          content: savedDocument.content,
          expectedVersion: initialDocument.version,
          operationId: expect.stringMatching(/^save_/),
          relativePath: initialDocument.relativePath,
          workspaceRoot: workspace.rootPath,
        });
        return {
          status: "saved",
          document: savedDocument,
          operationId: args?.operationId,
        };
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      isEditorDirty: false,
      status: "ready",
      workspace,
    });

    await saveCurrentDocument(savedDocument.content);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().activeDocument?.content).toBe(savedDocument.content);
    expect(useWorkspaceStore.getState().isEditorDirty).toBe(false);
  });

  it("preserves the local buffer when expected-version save detects a disk conflict", async () => {
    const initialDocument = makeDocument({
      content: "# Watch Test\n\nOriginal.\n",
      currentContentHash: "sha256:old",
    });
    const diskDocument = makeDocument({
      content: "# Watch Test\n\nDisk edit.\n",
      currentContentHash: "sha256:disk",
      updatedAt: "2026-03-19T00:05:00Z",
      version: {
        contentHash: "sha256:disk",
        modifiedNs: "123",
        size: 25,
      },
    });
    const localContent = "# Watch Test\n\nMargent edit.\n";
    const workspace = makeWorkspace(initialDocument);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "save_document_if_current") {
        expect(args).toEqual({
          content: localContent,
          expectedVersion: initialDocument.version,
          operationId: expect.stringMatching(/^save_/),
          relativePath: initialDocument.relativePath,
          workspaceRoot: workspace.rootPath,
        });
        return {
          status: "conflict",
          expectedVersion: initialDocument.version,
          actualVersion: diskDocument.version,
          operationId: args?.operationId,
        };
      }

      if (command === "read_document") {
        expect(args).toEqual({
          relativePath: initialDocument.relativePath,
          workspaceRoot: workspace.rootPath,
        });
        return diskDocument;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      isEditorDirty: false,
      status: "ready",
      workspace,
    });

    await saveCurrentDocument(localContent);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState().activeDocument?.content).toBe(initialDocument.content);
    expect(useWorkspaceStore.getState().pendingExternalDocument).toEqual(diskDocument);
    expect(useWorkspaceStore.getState().saveConflict?.localContent).toBe(localContent);
    expect(useWorkspaceStore.getState().saveConflict?.diskDocument).toEqual(diskDocument);
    expect(useWorkspaceStore.getState().isEditorDirty).toBe(true);
  });

  it("does not save unchanged clean content", async () => {
    const initialDocument = makeDocument({
      content: "# Watch Test\n\nOriginal.\n",
      currentContentHash: "sha256:old",
    });
    const workspace = makeWorkspace(initialDocument);

    invokeMock.mockImplementation(async (command) => {
      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      isEditorDirty: false,
      status: "ready",
      workspace,
    });

    await saveCurrentDocument(initialDocument.content);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refreshes the workspace document list when a new markdown file appears", async () => {
    const initialDocument = makeDocument();
    const newDocument = makeDocument({
      id: "doc-2",
      relativePath: "nested/new.md",
      absolutePath: "/tmp/margent-watch-test/nested/new.md",
      displayName: "new.md",
      currentContentHash: "sha256:new-doc",
      content: "# New Document\n",
      updatedAt: "2026-03-19T00:04:00Z",
      wordCount: 2,
    });
    const workspace = makeWorkspace(initialDocument);
    const refreshedWorkspace = makeWorkspace([initialDocument, newDocument]);
    const watchers = captureWorkspaceWatchers();

    invokeMock.mockImplementation(async (command) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "check_document_update") {
        return null;
      }

      if (command === "open_workspace") {
        return refreshedWorkspace;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      watchers.triggerWorkspaceWatch(
        makeWatchEvent({
          type: {
            create: {
              kind: "file",
            },
          },
          paths: [newDocument.absolutePath],
        }),
      );
    });

    await waitFor(() => expect(useWorkspaceStore.getState().workspace?.documents).toHaveLength(2));
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe(initialDocument.relativePath);
  });

  it("refreshes from the current active document instead of snapping back to the original opened file", async () => {
    const openedDocument = makeDocument({
      id: "doc-opened",
      relativePath: "ACCEPTANCE.md",
      absolutePath: "/tmp/margent-watch-test/ACCEPTANCE.md",
      displayName: "ACCEPTANCE.md",
      currentContentHash: "sha256:acceptance",
    });
    const activeDocument = makeDocument({
      id: "doc-active",
      relativePath: "notes/runtime-check.md",
      absolutePath: "/tmp/margent-watch-test/notes/runtime-check.md",
      displayName: "runtime-check.md",
      currentContentHash: "sha256:runtime-check",
    });
    const workspace = {
      ...makeWorkspace([openedDocument, activeDocument]),
      openedPath: openedDocument.absolutePath,
      selectedRelativePath: activeDocument.relativePath,
    };
    const refreshedWorkspace = {
      ...makeWorkspace([openedDocument, activeDocument]),
      openedPath: activeDocument.absolutePath,
      selectedRelativePath: activeDocument.relativePath,
    };
    const watchers = captureWorkspaceWatchers();

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "check_document_update") {
        return null;
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: activeDocument.absolutePath });
        return refreshedWorkspace;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      watchers.triggerWorkspaceWatch(
        makeWatchEvent({
          type: {
            create: {
              kind: "file",
            },
          },
          paths: ["/tmp/margent-watch-test/notes/new-file.md"],
        }),
      );
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().workspace?.openedPath).toBe(activeDocument.absolutePath),
    );
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe(activeDocument.relativePath);
  });

  it("ignores non-structural markdown modify events for workspace refresh", async () => {
    const initialDocument = makeDocument();
    const workspace = makeWorkspace(initialDocument);
    const watchers = captureWorkspaceWatchers();

    invokeMock.mockImplementation(async (command) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "check_document_update") {
        return null;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      status: "ready",
      workspace,
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2));
    invokeMock.mockClear();

    await act(async () => {
      watchers.triggerWorkspaceWatch(
        makeWatchEvent({
          paths: [initialDocument.absolutePath],
        }),
      );
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("workspace file operations", () => {
  it("creates a markdown file and selects it without waiting for watcher refresh", async () => {
    const initialDocument = makeDocument();
    const newDocument = makeDocument({
      id: "doc-new",
      relativePath: "drafts/new.md",
      absolutePath: "/tmp/margent-watch-test/drafts/new.md",
      displayName: "new.md",
      currentContentHash: "sha256:new",
      content: "# New\n",
    });
    const workspace = makeWorkspace(initialDocument);
    const refreshedWorkspace = makeWorkspace([initialDocument, newDocument]);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "create_markdown_file") {
        expect(args).toEqual({
          content: "",
          relativePath: "drafts/new.md",
          workspaceRoot: workspace.rootPath,
        });
        return newDocument;
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: newDocument.absolutePath });
        return refreshedWorkspace;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument: initialDocument,
      status: "ready",
      workspace,
    });

    await createMarkdownFile("drafts/new.md");

    expect(useWorkspaceStore.getState().status).toBe("ready");
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe("drafts/new.md");
    expect(useWorkspaceStore.getState().workspace?.documents).toHaveLength(2);
  });

  it("blocks renaming the dirty active document", async () => {
    const activeDocument = makeDocument();
    const workspace = makeWorkspace(activeDocument);

    useWorkspaceStore.setState({
      activeDocument,
      isEditorDirty: true,
      status: "ready",
      workspace,
    });

    await renameMarkdownFile(activeDocument.relativePath, "renamed.md");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().errorMessage).toBe(
      "Save the active draft before renaming it.",
    );
  });

  it("renames the active document and keeps it selected", async () => {
    const activeDocument = makeDocument();
    const renamedDocument = makeDocument({
      id: "doc-renamed",
      relativePath: "renamed.md",
      absolutePath: "/tmp/margent-watch-test/renamed.md",
      displayName: "renamed.md",
      currentContentHash: "sha256:renamed",
    });
    const workspace = makeWorkspace(activeDocument);
    const refreshedWorkspace = makeWorkspace(renamedDocument);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "rename_markdown_file") {
        expect(args).toEqual({
          fromRelativePath: activeDocument.relativePath,
          toRelativePath: "renamed.md",
          workspaceRoot: workspace.rootPath,
        });
        return renamedDocument;
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: renamedDocument.absolutePath });
        return refreshedWorkspace;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument,
      status: "ready",
      workspace,
    });

    await renameMarkdownFile(activeDocument.relativePath, "renamed.md");

    expect(useWorkspaceStore.getState().status).toBe("ready");
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe("renamed.md");
    expect(useWorkspaceStore.getState().workspace?.selectedRelativePath).toBe("renamed.md");
  });

  it("deletes the active document and selects the next available document", async () => {
    const firstDocument = makeDocument({
      id: "doc-first",
      relativePath: "first.md",
      absolutePath: "/tmp/margent-watch-test/first.md",
      displayName: "first.md",
    });
    const secondDocument = makeDocument({
      id: "doc-second",
      relativePath: "second.md",
      absolutePath: "/tmp/margent-watch-test/second.md",
      displayName: "second.md",
      currentContentHash: "sha256:second",
    });
    const workspace = makeWorkspace([firstDocument, secondDocument]);
    const refreshedWorkspace = makeWorkspace(secondDocument);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "delete_markdown_file") {
        expect(args).toEqual({
          relativePath: "first.md",
          workspaceRoot: workspace.rootPath,
        });
        return refreshedWorkspace;
      }

      if (command === "read_document") {
        expect(args).toEqual({
          relativePath: "second.md",
          workspaceRoot: workspace.rootPath,
        });
        return secondDocument;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    useWorkspaceStore.setState({
      activeDocument: firstDocument,
      status: "ready",
      workspace,
    });

    await deleteMarkdownFile("first.md");

    expect(useWorkspaceStore.getState().status).toBe("ready");
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe("second.md");
    expect(useWorkspaceStore.getState().workspace?.documents).toHaveLength(1);
  });
});

describe("thread watcher behavior", () => {
  it("reloads active threads when shared review data changes", async () => {
    const activeDocument = makeDocument();
    const workspace = makeWorkspace(activeDocument);
    const initialThread = makeThread({
      id: "thread-1",
      updatedAt: "2026-03-19T00:00:00Z",
      title: "Initial thread",
    });
    const updatedThread = makeThread({
      id: "thread-2",
      updatedAt: "2026-03-19T00:03:00Z",
      title: "Updated thread",
    });

    let threadsWatchCallback: (() => void) | null = null;
    let hasExternalThreadChange = false;

    watchMock.mockImplementation(async (_path, callback) => {
      threadsWatchCallback = () => callback({});
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_all_threads") {
        return hasExternalThreadChange ? [updatedThread] : [initialThread];
      }

      if (command === "load_all_proposals") {
        return [];
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(ThreadsHarness, { activeDocument, workspace }));

    await waitFor(() => expect(useThreadStore.getState().threads[0]?.id).toBe("thread-1"));
    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      hasExternalThreadChange = true;
      threadsWatchCallback?.();
    });

    await waitFor(() => expect(useThreadStore.getState().threads[0]?.id).toBe("thread-2"));
  });

  it("performs a settled follow-up refresh so atomic thread rewrites are not missed", async () => {
    const activeDocument = makeDocument();
    const workspace = makeWorkspace(activeDocument);
    const initialThread = makeThread({
      id: "thread-1",
      updatedAt: "2026-03-19T00:00:00Z",
      title: "Initial thread",
    });
    const updatedThread = makeThread({
      id: "thread-1",
      updatedAt: "2026-03-19T00:05:00Z",
      title: "Updated thread",
      messages: [
        {
          id: "msg-1",
          threadId: "thread-1",
          authorType: "user",
          authorName: "You",
          agentId: null,
          adapterId: null,
          replyToMessageId: null,
          createdAt: "2026-03-19T00:05:00Z",
          body: "Updated from external write",
          kind: "reply",
        },
      ],
    });

    let threadsWatchCallback: (() => void) | null = null;
    let externalChangeVisible = false;

    watchMock.mockImplementation(async (_path, callback) => {
      threadsWatchCallback = () => {
        window.setTimeout(() => {
          externalChangeVisible = true;
        }, 100);
        callback({});
      };
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_all_threads") {
        return externalChangeVisible ? [updatedThread] : [initialThread];
      }

      if (command === "load_all_proposals") {
        return [];
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(ThreadsHarness, { activeDocument, workspace }));

    await waitFor(() => expect(useThreadStore.getState().threads[0]?.title).toBe("Initial thread"));
    await waitFor(() => expect(watchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      threadsWatchCallback?.();
    });

    expect(useThreadStore.getState().threads[0]?.title).toBe("Initial thread");

    await act(async () => {
      await new Promise((resolve) =>
        window.setTimeout(resolve, SETTLED_REVIEW_REFRESH_DELAY_MS + 50),
      );
    });

    await waitFor(() => expect(useThreadStore.getState().threads[0]?.title).toBe("Updated thread"));
    expect(useThreadStore.getState().threads[0]?.messages).toHaveLength(1);
  });

  it("refreshes proposals and active threads from the same review watcher", async () => {
    const activeDocument = makeDocument();
    const workspace = makeWorkspace(activeDocument);
    const initialThread = makeThread({
      id: "thread-1",
      updatedAt: "2026-03-19T00:00:00Z",
      title: "Initial thread",
    });
    const updatedThread = makeThread({
      id: "thread-1",
      updatedAt: "2026-03-19T00:07:00Z",
      title: "Shared watcher thread",
    });
    const initialProposal = makeProposal({
      id: "proposal-1",
      updatedAt: "2026-03-19T00:00:00Z",
      summary: "Initial proposal",
    });
    const updatedProposal = makeProposal({
      id: "proposal-1",
      updatedAt: "2026-03-19T00:07:00Z",
      summary: "Shared watcher proposal",
    });

    let threadsWatchCallback: (() => void) | null = null;
    let externalChangeVisible = false;

    watchMock.mockImplementation(async (_path, callback) => {
      threadsWatchCallback = () => callback({});
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_all_threads") {
        return externalChangeVisible ? [updatedThread] : [initialThread];
      }

      if (command === "load_all_proposals") {
        return externalChangeVisible ? [updatedProposal] : [initialProposal];
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(ThreadsHarness, { activeDocument, workspace }));

    await waitFor(() => expect(useThreadStore.getState().threads[0]?.title).toBe("Initial thread"));
    await waitFor(() =>
      expect(useReviewDataStore.getState().proposals[0]?.summary).toBe("Initial proposal"),
    );

    await act(async () => {
      externalChangeVisible = true;
      threadsWatchCallback?.();
    });

    await waitFor(() =>
      expect(useThreadStore.getState().threads[0]?.title).toBe("Shared watcher thread"),
    );
    expect(useReviewDataStore.getState().proposals[0]?.summary).toBe("Shared watcher proposal");
  });

  it("ignores stale shared review data after switching workspaces", async () => {
    const firstDocument = makeDocument({
      id: "doc-first",
      relativePath: "first.md",
      absolutePath: "/tmp/margent-watch-first/first.md",
      displayName: "first.md",
    });
    const secondDocument = makeDocument({
      id: "doc-second",
      relativePath: "second.md",
      absolutePath: "/tmp/margent-watch-second/second.md",
      displayName: "second.md",
    });
    const firstWorkspace = {
      ...makeWorkspace(firstDocument),
      mdreviewPath: "/tmp/margent-watch-first/.mdreview",
      rootPath: "/tmp/margent-watch-first",
    };
    const secondWorkspace = {
      ...makeWorkspace(secondDocument),
      mdreviewPath: "/tmp/margent-watch-second/.mdreview",
      rootPath: "/tmp/margent-watch-second",
    };
    const firstThread = makeThread({
      documentId: "doc-first",
      id: "thread-first",
      title: "First workspace thread",
    });
    const secondThread = makeThread({
      documentId: "doc-second",
      id: "thread-second",
      title: "Second workspace thread",
    });

    let resolveFirstThreads: ((threads: ThreadRecord[]) => void) | null = null;
    let resolveFirstProposals: ((proposals: ProposalRecord[]) => void) | null = null;

    watchMock.mockImplementation(async () => vi.fn());
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "load_all_threads") {
        if (args.workspaceRoot === firstWorkspace.rootPath) {
          return new Promise<ThreadRecord[]>((resolve) => {
            resolveFirstThreads = resolve;
          });
        }

        if (args.workspaceRoot === secondWorkspace.rootPath) {
          return [secondThread];
        }
      }

      if (command === "load_all_proposals") {
        if (args.workspaceRoot === firstWorkspace.rootPath) {
          return new Promise<ProposalRecord[]>((resolve) => {
            resolveFirstProposals = resolve;
          });
        }

        if (args.workspaceRoot === secondWorkspace.rootPath) {
          return [];
        }
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    const { rerender } = render(
      createElement(ThreadsHarness, {
        activeDocument: firstDocument,
        workspace: firstWorkspace,
      }),
    );

    await waitFor(() => {
      expect(resolveFirstThreads).not.toBeNull();
      expect(resolveFirstProposals).not.toBeNull();
    });

    rerender(
      createElement(ThreadsHarness, {
        activeDocument: secondDocument,
        workspace: secondWorkspace,
      }),
    );

    await waitFor(() =>
      expect(useThreadStore.getState().threads[0]?.title).toBe("Second workspace thread"),
    );

    await act(async () => {
      resolveFirstThreads?.([firstThread]);
      resolveFirstProposals?.([]);
      await Promise.resolve();
    });

    expect(useThreadStore.getState().threads[0]?.title).toBe("Second workspace thread");
    expect(useReviewDataStore.getState().threads[0]?.title).toBe("Second workspace thread");
  });

  it("refreshes threads when the app regains focus even if no watcher event fired", async () => {
    const activeDocument = makeDocument();
    const workspace = makeWorkspace(activeDocument);
    const initialThread = makeThread({
      id: "thread-1",
      updatedAt: "2026-03-19T00:00:00Z",
      title: "Initial thread",
    });
    const updatedThread = makeThread({
      id: "thread-1",
      updatedAt: "2026-03-19T00:06:00Z",
      title: "Focused refresh thread",
      messages: [
        {
          id: "msg-1",
          threadId: "thread-1",
          authorType: "agent",
          authorName: "Claude",
          agentId: "claude",
          adapterId: null,
          replyToMessageId: null,
          createdAt: "2026-03-19T00:06:00Z",
          body: "Updated while the app was in the background",
          kind: "reply",
        },
      ],
    });

    let externalChangeVisible = false;

    watchMock.mockImplementation(async () => vi.fn());
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_all_threads") {
        return externalChangeVisible ? [updatedThread] : [initialThread];
      }

      if (command === "load_all_proposals") {
        return [];
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(ThreadsHarness, { activeDocument, workspace }));

    await waitFor(() => expect(useThreadStore.getState().threads[0]?.title).toBe("Initial thread"));

    await act(async () => {
      externalChangeVisible = true;
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(useThreadStore.getState().threads[0]?.title).toBe("Focused refresh thread"),
    );
    expect(useThreadStore.getState().threads[0]?.messages).toHaveLength(1);
  });
});
