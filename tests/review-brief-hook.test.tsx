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

function ReviewBriefHarness() {
  const reviewBrief = useReviewBrief({
    activeDocument,
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
  it("uses shared review data on mount and fetches only on explicit refresh", async () => {
    const thread = makeThread();
    const proposal = makeProposal();

    invokeBackendMock.mockImplementation(async (command) => {
      if (command === "load_all_threads") {
        return [thread];
      }

      if (command === "load_all_proposals") {
        return [proposal];
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(createElement(ReviewBriefHarness));

    expect(invokeBackendMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(invokeBackendMock).toHaveBeenCalledTimes(2));
    expect(invokeBackendMock).toHaveBeenNthCalledWith(1, "load_all_threads", {
      workspaceRoot: workspace.rootPath,
    });
    expect(invokeBackendMock).toHaveBeenNthCalledWith(2, "load_all_proposals", {
      workspaceRoot: workspace.rootPath,
    });
    expect(useReviewDataStore.getState().threads).toEqual([thread]);
    expect(useReviewDataStore.getState().proposals).toEqual([proposal]);
  });
});
