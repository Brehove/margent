import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreads } from "../src/hooks/useThreads";
import { invokeBackend } from "../src/lib/backend";
import { useReviewDataStore } from "../src/stores/reviewDataStore";
import { useThreadStore } from "../src/stores/threadStore";
import type { AnchorRecord, ThreadRecord } from "../src/types/thread";
import type { DocumentPayload, WorkspaceSnapshot } from "../src/types/workspace";

vi.mock("../src/lib/backend", () => ({
  invokeBackend: vi.fn(),
}));

const invokeBackendMock = vi.mocked(invokeBackend);

const activeDocument: DocumentPayload = {
  absolutePath: "/tmp/margent-threads/draft.md",
  content: "Draft body",
  createdAt: "2026-06-21T00:00:00Z",
  currentContentHash: "sha256:base",
  displayName: "draft.md",
  frontmatterMode: "none",
  headingIndex: [],
  id: "doc-1",
  lastKnownLineEnding: "lf",
  relativePath: "draft.md",
  updatedAt: "2026-06-21T00:00:00Z",
  version: {
    contentHash: "sha256:base",
    modifiedNs: null,
    size: 10,
  },
  wordCount: 2,
};

const workspace: WorkspaceSnapshot = {
  documents: [activeDocument],
  mdreviewPath: "/tmp/margent-threads/.mdreview",
  openedPath: null,
  rootPath: "/tmp/margent-threads",
  selectedRelativePath: activeDocument.relativePath,
};

const anchor: AnchorRecord = {
  baseContentHash: activeDocument.currentContentHash,
  blockFingerprint: "sha256:block",
  confidence: 1,
  endColumn: 11,
  endLine: 1,
  endOffsetUtf16: 10,
  headingPath: [],
  prefixContext: "",
  quote: "Draft body",
  startColumn: 1,
  startLine: 1,
  startOffsetUtf16: 0,
  state: "attached",
  suffixContext: "",
};

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    anchor,
    createdAt: "2026-06-21T00:00:00Z",
    createdBy: "user",
    documentId: activeDocument.id,
    id: "thread-1",
    linkedProposalIds: [],
    messages: [],
    providerSessions: {},
    schemaVersion: 1,
    status: "open",
    tags: [],
    title: "Thread",
    updatedAt: "2026-06-21T00:00:00Z",
    ...overrides,
  };
}

function ThreadsHarness({
  document,
}: {
  document: DocumentPayload | null;
}) {
  const threadState = useThreads({
    activeDocument: document,
    workspace,
  });

  return createElement(
    "output",
    { "aria-label": "thread-count" },
    String(threadState.threads.length),
  );
}

beforeEach(() => {
  cleanup();
  invokeBackendMock.mockReset();
  useReviewDataStore.getState().reset();
  useThreadStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("useThreads", () => {
  it("derives active-document threads from shared review data without fetching", () => {
    useReviewDataStore.getState().setReviewData({
      proposals: [],
      threads: [
        makeThread(),
        makeThread({ documentId: "doc-other", id: "thread-other" }),
      ],
    });

    const { rerender } = render(createElement(ThreadsHarness, { document: activeDocument }));

    expect(screen.getByLabelText("thread-count")).toHaveTextContent("1");
    expect(invokeBackendMock).not.toHaveBeenCalled();

    rerender(
      createElement(ThreadsHarness, {
        document: {
          ...activeDocument,
          currentContentHash: "sha256:external-change",
        },
      }),
    );

    expect(screen.getByLabelText("thread-count")).toHaveTextContent("1");
    expect(invokeBackendMock).not.toHaveBeenCalled();
  });
});
