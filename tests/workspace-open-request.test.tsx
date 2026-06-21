import { createElement } from "react";
import { render, waitFor, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { watch } from "@tauri-apps/plugin-fs";
import { openWorkspacePath, useWorkspaceEffects } from "../src/hooks/useWorkspace";
import { useThreadStore } from "../src/stores/threadStore";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import type { DocumentPayload, WorkspaceOpenRequest, WorkspaceSnapshot } from "../src/types/workspace";

const invokeMock = vi.mocked(invoke);
const isTauriMock = vi.mocked(isTauri);
const listenMock = vi.mocked(listen);
const watchMock = vi.mocked(watch);

function makeDocument(overrides: Partial<DocumentPayload> = {}): DocumentPayload {
  const document = {
    schemaVersion: 1,
    id: "doc-1",
    relativePath: "brainstorming/claw-psychosis.md",
    absolutePath:
      "/tmp/margent-open-request-test/brainstorming/claw-psychosis.md",
    displayName: "claw-psychosis.md",
    createdAt: "2026-04-09T00:00:00Z",
    updatedAt: "2026-04-09T00:00:00Z",
    currentContentHash: "sha256:doc",
    lastKnownLineEnding: "lf",
    frontmatterMode: "none",
    wordCount: 3,
    headingIndex: [],
    content: "# Open Request Test\n\nAlpha beta gamma.\n",
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

function makeWorkspace(document: DocumentPayload): WorkspaceSnapshot {
  return {
    rootPath: "/tmp/margent-open-request-test",
    openedPath: document.absolutePath,
    mdreviewPath: "/tmp/margent-open-request-test/.mdreview",
    selectedRelativePath: document.relativePath,
    documents: [
      {
        id: document.id,
        relativePath: document.relativePath,
        displayName: document.displayName,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        currentContentHash: document.currentContentHash,
        lastKnownLineEnding: document.lastKnownLineEnding,
        frontmatterMode: document.frontmatterMode,
        wordCount: document.wordCount,
        headingIndex: document.headingIndex,
      },
    ],
  };
}

function WorkspaceEffectsHarness() {
  useWorkspaceEffects();
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  invokeMock.mockReset();
  isTauriMock.mockReset();
  listenMock.mockReset();
  watchMock.mockReset();
  useThreadStore.getState().reset();
  useWorkspaceStore.getState().reset();
  isTauriMock.mockReturnValue(true);
  listenMock.mockResolvedValue(vi.fn());
  watchMock.mockResolvedValue(vi.fn());
});

afterEach(() => {
  cleanup();
});

describe("workspace open-request behavior", () => {
  it("restores the most recent workspace when launch has no open request", async () => {
    const document = makeDocument({
      relativePath: "notes/restored.md",
      absolutePath: "/tmp/margent-open-request-test/notes/restored.md",
      displayName: "restored.md",
      currentContentHash: "sha256:restored",
    });
    const workspace = makeWorkspace(document);
    window.localStorage.setItem(
      "margent:recent-workspaces",
      JSON.stringify([
        {
          activeRelativePath: document.relativePath,
          label: "margent-open-request-test",
          openedPath: null,
          rootPath: workspace.rootPath,
          updatedAt: "2026-06-11T00:00:00.000Z",
        },
      ]),
    );

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: workspace.rootPath });
        return workspace;
      }

      if (command === "read_document") {
        expect(args).toEqual({
          relativePath: document.relativePath,
          workspaceRoot: workspace.rootPath,
        });
        return document;
      }

      if (command === "check_document_update") {
        return null;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(useWorkspaceStore.getState().status).toBe("ready"));
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe(document.relativePath);
  });

  it("lets pending launch requests win over recent workspace restore", async () => {
    const document = makeDocument();
    const workspace = makeWorkspace(document);
    const request: WorkspaceOpenRequest = {
      id: 1,
      path: document.absolutePath,
    };
    window.localStorage.setItem(
      "margent:recent-workspaces",
      JSON.stringify([
        {
          activeRelativePath: "stale.md",
          label: "stale",
          openedPath: null,
          rootPath: "/tmp/stale-workspace",
          updatedAt: "2026-06-11T00:00:00.000Z",
        },
      ]),
    );

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [request];
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: document.absolutePath });
        return workspace;
      }

      if (command === "read_document") {
        return document;
      }

      if (command === "check_document_update") {
        return null;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(useWorkspaceStore.getState().status).toBe("ready"));
    expect(useWorkspaceStore.getState().workspace?.rootPath).toBe(workspace.rootPath);
  });

  it("quietly forgets a stale recent workspace when restore fails", async () => {
    window.localStorage.setItem(
      "margent:recent-workspaces",
      JSON.stringify([
        {
          activeRelativePath: "missing.md",
          label: "missing",
          openedPath: null,
          rootPath: "/tmp/missing-workspace",
          updatedAt: "2026-06-11T00:00:00.000Z",
        },
      ]),
    );

    invokeMock.mockImplementation(async (command) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "open_workspace") {
        throw new Error("missing");
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(useWorkspaceStore.getState().status).toBe("idle"));
    expect(useWorkspaceStore.getState().errorMessage).toBeNull();
    expect(window.localStorage.getItem("margent:recent-workspaces")).toBeNull();
  });

  it("hydrates the workspace from pending launch requests", async () => {
    const document = makeDocument();
    const workspace = makeWorkspace(document);
    const request: WorkspaceOpenRequest = {
      id: 1,
      path: document.absolutePath,
    };

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [request];
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: document.absolutePath });
        return workspace;
      }

      if (command === "read_document") {
        expect(args).toEqual({
          relativePath: document.relativePath,
          workspaceRoot: workspace.rootPath,
        });
        return document;
      }

      if (command === "check_document_update") {
        return null;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(useWorkspaceStore.getState().status).toBe("ready"));
    expect(useWorkspaceStore.getState().workspace?.rootPath).toBe(workspace.rootPath);
    expect(useWorkspaceStore.getState().activeDocument?.absolutePath).toBe(document.absolutePath);
  });

  it("hydrates the workspace when a live open-request event arrives", async () => {
    const document = makeDocument({
      id: "doc-2",
      relativePath: "brainstorming/claw-psychosis-draft.md",
      absolutePath:
        "/tmp/margent-open-request-test/brainstorming/claw-psychosis-draft.md",
      displayName: "claw-psychosis-draft.md",
      currentContentHash: "sha256:draft",
    });
    const workspace = makeWorkspace(document);
    const request: WorkspaceOpenRequest = {
      id: 2,
      path: document.absolutePath,
    };

    let eventCallback: ((event: { payload: WorkspaceOpenRequest }) => void) | null = null;
    listenMock.mockImplementation(async (_eventName, callback) => {
      eventCallback = callback as (event: { payload: WorkspaceOpenRequest }) => void;
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [];
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: document.absolutePath });
        return workspace;
      }

      if (command === "read_document") {
        expect(args).toEqual({
          relativePath: document.relativePath,
          workspaceRoot: workspace.rootPath,
        });
        return document;
      }

      if (command === "check_document_update") {
        return null;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      eventCallback?.({ payload: request });
    });

    await waitFor(() => expect(useWorkspaceStore.getState().status).toBe("ready"));
    expect(useWorkspaceStore.getState().workspace?.rootPath).toBe(workspace.rootPath);
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe(document.relativePath);
  });

  it("opens deep-link requests to a workspace document and selected thread", async () => {
    const document = makeDocument({
      id: "doc-deep-link",
      relativePath: "notes/deep-link.md",
      absolutePath: "/tmp/margent-open-request-test/notes/deep-link.md",
      displayName: "deep-link.md",
      currentContentHash: "sha256:deep-link",
    });
    const workspace = makeWorkspace(document);
    const request: WorkspaceOpenRequest = {
      documentRelativePath: document.relativePath,
      id: 3,
      path: document.absolutePath,
      threadId: "thread-deep-link",
      workspaceRoot: workspace.rootPath,
    };

    useThreadStore.getState().setThreads([
      {
        anchor: {
          baseContentHash: "sha256:deep-link",
          blockFingerprint: "sha256:block",
          confidence: 1,
          endColumn: 1,
          endLine: 1,
          endOffsetUtf16: 1,
          headingPath: [],
          prefixContext: "",
          quote: "",
          startColumn: 1,
          startLine: 1,
          startOffsetUtf16: 0,
          state: "attached",
          suffixContext: "",
        },
        createdAt: "2026-06-11T00:00:00Z",
        createdBy: "tester",
        documentId: document.id,
        id: "thread-deep-link",
        linkedProposalIds: [],
        messages: [],
        schemaVersion: 6,
        status: "open",
        tags: [],
        title: "Deep link target",
        updatedAt: "2026-06-11T00:00:00Z",
      },
    ]);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "take_pending_open_requests") {
        return [request];
      }

      if (command === "open_workspace") {
        expect(args).toEqual({ path: workspace.rootPath });
        return workspace;
      }

      if (command === "read_document") {
        expect(args).toEqual({
          relativePath: document.relativePath,
          workspaceRoot: workspace.rootPath,
        });
        return document;
      }

      if (command === "check_document_update") {
        return null;
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    render(createElement(WorkspaceEffectsHarness));

    await waitFor(() => expect(useWorkspaceStore.getState().status).toBe("ready"));
    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe(document.relativePath);
    expect(useThreadStore.getState().selectedThreadId).toBe("thread-deep-link");
  });

  it("ignores stale workspace hydrations when a newer open request wins the race", async () => {
    const earlierDocument = makeDocument({
      id: "doc-earlier",
      relativePath: "older.md",
      absolutePath: "/tmp/margent-open-request-test/older.md",
      displayName: "older.md",
      currentContentHash: "sha256:older",
    });
    const laterDocument = makeDocument({
      id: "doc-later",
      relativePath: "newer.md",
      absolutePath: "/tmp/margent-open-request-test/newer.md",
      displayName: "newer.md",
      currentContentHash: "sha256:newer",
    });
    const earlierWorkspace = makeWorkspace(earlierDocument);
    const laterWorkspace = makeWorkspace(laterDocument);
    const olderOpen = createDeferred<WorkspaceSnapshot>();

    invokeMock.mockImplementation((command, args) => {
      if (command === "open_workspace") {
        if (args?.path === earlierDocument.absolutePath) {
          return olderOpen.promise;
        }

        if (args?.path === laterDocument.absolutePath) {
          return Promise.resolve(laterWorkspace);
        }
      }

      if (command === "read_document") {
        if (args?.relativePath === earlierDocument.relativePath) {
          return Promise.resolve(earlierDocument);
        }

        if (args?.relativePath === laterDocument.relativePath) {
          return Promise.resolve(laterDocument);
        }
      }

      if (command === "take_pending_open_requests") {
        return Promise.resolve([]);
      }

      if (command === "check_document_update") {
        return Promise.resolve(null);
      }

      throw new Error(`Unexpected invoke command: ${command}`);
    });

    const olderRequest = openWorkspacePath(earlierDocument.absolutePath);
    const newerRequest = openWorkspacePath(laterDocument.absolutePath);

    await newerRequest;
    await waitFor(() => expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe("newer.md"));

    olderOpen.resolve(earlierWorkspace);
    await olderRequest;

    expect(useWorkspaceStore.getState().activeDocument?.relativePath).toBe("newer.md");
    expect(useWorkspaceStore.getState().workspace?.selectedRelativePath).toBe("newer.md");
  });
});
