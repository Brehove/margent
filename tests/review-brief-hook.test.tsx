import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeBackend } from "../src/lib/backend";
import { useReviewBrief } from "../src/hooks/useReviewBrief";
import { useReviewDataStore } from "../src/stores/reviewDataStore";
import type { ProposalRecord } from "../src/types/proposal";
import type { AnchorRecord, ThreadRecord } from "../src/types/thread";
import type { DocumentPayload, WorkspaceSnapshot } from "../src/types/workspace";

vi.mock("../src/lib/backend", () => ({
  invokeBackend: vi.fn(),
}));

const invokeBackendMock = vi.mocked(invokeBackend);

const anchor: AnchorRecord = {
  baseContentHash: "sha256:base",
  blockFingerprint: "sha256:block",
  confidence: 1,
  endColumn: 17,
  endLine: 1,
  endOffsetUtf16: 16,
  headingPath: [],
  prefixContext: "",
  quote: "Target paragraph",
  startColumn: 1,
  startLine: 1,
  startOffsetUtf16: 0,
  state: "attached",
  suffixContext: "",
};

const activeDocument: DocumentPayload = {
  absolutePath: "/tmp/margent-review-brief/draft.md",
  content: "Target paragraph",
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
    size: 16,
  },
  wordCount: 2,
};

const workspace: WorkspaceSnapshot = {
  documents: [activeDocument],
  mdreviewPath: "/tmp/margent-review-brief/.mdreview",
  openedPath: null,
  rootPath: "/tmp/margent-review-brief",
  selectedRelativePath: activeDocument.relativePath,
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

function makeProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    adapterId: "codex",
    assistantMessage: "Tightened the paragraph.",
    baseContentHash: activeDocument.currentContentHash,
    computedDiff: "",
    createdAt: "2026-06-21T00:00:00Z",
    documentId: activeDocument.id,
    errorMessage: null,
    id: "proposal-1",
    resolveThreadIds: [],
    responseMode: "updated_document",
    schemaVersion: 1,
    status: "pending",
    stderr: null,
    summary: "Tightened the paragraph.",
    threadIds: ["thread-1"],
    unifiedDiff: null,
    updatedAt: "2026-06-21T00:00:00Z",
    updatedDocumentText: "Tighter paragraph.",
    warnings: [],
    ...overrides,
  };
}

function ReviewBriefHarness({
  onRefreshReviewData,
}: {
  onRefreshReviewData?: () => Promise<void>;
}) {
  const reviewBrief = useReviewBrief({
    activeDocument,
    onRefreshReviewData,
    workspace,
  });

  return createElement(
    "button",
    {
      onClick: () => {
        void reviewBrief.loadBrief();
      },
      type: "button",
    },
    "Refresh",
  );
}

beforeEach(() => {
  cleanup();
  invokeBackendMock.mockReset();
  useReviewDataStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("useReviewBrief", () => {
  it("uses shared review data on mount and delegates explicit refresh", async () => {
    const thread = makeThread();
    const proposal = makeProposal();
    const refreshReviewData = vi.fn(async () => {
      useReviewDataStore.getState().setReviewData({
        proposals: [proposal],
        threads: [thread],
      });
    });

    render(createElement(ReviewBriefHarness, { onRefreshReviewData: refreshReviewData }));

    expect(invokeBackendMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(refreshReviewData).toHaveBeenCalledTimes(1));
    expect(invokeBackendMock).not.toHaveBeenCalled();
    expect(useReviewDataStore.getState().threads).toEqual([thread]);
    expect(useReviewDataStore.getState().proposals).toEqual([proposal]);
  });
});
