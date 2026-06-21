import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProposals } from "../src/hooks/useProposals";
import { invokeBackend } from "../src/lib/backend";
import { useReviewDataStore } from "../src/stores/reviewDataStore";
import type { ProposalRecord } from "../src/types/proposal";
import type { DocumentPayload, WorkspaceSnapshot } from "../src/types/workspace";

vi.mock("../src/lib/backend", () => ({
  invokeBackend: vi.fn(),
}));

const invokeBackendMock = vi.mocked(invokeBackend);

const activeDocument: DocumentPayload = {
  absolutePath: "/tmp/margent-proposals/draft.md",
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
  mdreviewPath: "/tmp/margent-proposals/.mdreview",
  openedPath: null,
  rootPath: "/tmp/margent-proposals",
  selectedRelativePath: activeDocument.relativePath,
};

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
    threadIds: [],
    unifiedDiff: null,
    updatedAt: "2026-06-21T00:00:00Z",
    updatedDocumentText: "Tighter body.",
    warnings: [],
    ...overrides,
  };
}

function ProposalsHarness({
  document,
}: {
  document: DocumentPayload | null;
}) {
  const proposalState = useProposals({
    activeDocument: document,
    workspace,
  });

  return createElement(
    "output",
    { "aria-label": "proposal-count" },
    String(proposalState.proposals.length),
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

describe("useProposals", () => {
  it("derives active-document proposals from shared review data without fetching", () => {
    useReviewDataStore.getState().setReviewData({
      proposals: [
        makeProposal(),
        makeProposal({ documentId: "doc-other", id: "proposal-other" }),
      ],
      threads: [],
    });

    const { rerender } = render(createElement(ProposalsHarness, { document: activeDocument }));

    expect(screen.getByLabelText("proposal-count")).toHaveTextContent("1");
    expect(invokeBackendMock).not.toHaveBeenCalled();

    rerender(
      createElement(ProposalsHarness, {
        document: {
          ...activeDocument,
          currentContentHash: "sha256:external-change",
        },
      }),
    );

    expect(screen.getByLabelText("proposal-count")).toHaveTextContent("1");
    expect(invokeBackendMock).not.toHaveBeenCalled();
  });
});
