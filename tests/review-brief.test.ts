import { describe, expect, it } from "vitest";
import { buildReviewBriefEntries } from "../src/hooks/useReviewBrief";
import type { ProposalRecord } from "../src/types/proposal";
import type { MessageRecord, ThreadRecord } from "../src/types/thread";
import type { DocumentSummary } from "../src/types/workspace";

const documentRecord: DocumentSummary = {
  id: "doc-1",
  relativePath: "draft.md",
  displayName: "draft.md",
  createdAt: "2026-06-11T00:00:00Z",
  updatedAt: "2026-06-11T00:00:00Z",
  currentContentHash: "sha256:current",
  lastKnownLineEnding: "\n",
  frontmatterMode: "none",
  wordCount: 24,
  headingIndex: [],
};

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    threadId: "thread-1",
    authorType: "user",
    authorName: "Reviewer",
    agentId: null,
    adapterId: null,
    replyToMessageId: null,
    createdAt: "2026-06-11T00:00:00Z",
    body: "Please review this.",
    kind: "comment",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    schemaVersion: 6,
    id: "thread-1",
    documentId: documentRecord.id,
    status: "open",
    createdAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:02:00Z",
    createdBy: "user",
    title: "Review this paragraph",
    tags: [],
    anchor: {
      quote: "Target paragraph",
      prefixContext: "",
      suffixContext: "",
      startOffsetUtf16: 0,
      endOffsetUtf16: 16,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 17,
      headingPath: [],
      blockFingerprint: "sha256:block",
      baseContentHash: "sha256:current",
      state: "attached",
      confidence: 1,
    },
    createdContentHash: "sha256:current",
    lastReanchorContentHash: "sha256:current",
    reviewDone: false,
    reviewRound: null,
    messages: [makeMessage()],
    linkedProposalIds: [],
    providerSessions: {},
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    schemaVersion: 1,
    id: "proposal-1",
    documentId: documentRecord.id,
    threadIds: ["thread-1"],
    adapterId: "codex",
    createdAt: "2026-06-11T00:03:00Z",
    updatedAt: "2026-06-11T00:03:00Z",
    status: "pending",
    baseContentHash: "sha256:current",
    responseMode: "updated_document",
    summary: "Tightened the paragraph.",
    assistantMessage: "I tightened the paragraph.",
    updatedDocumentText: "New draft",
    unifiedDiff: null,
    computedDiff: "@@ -1 +1 @@\n-Old\n+New",
    warnings: [],
    resolveThreadIds: [],
    stderr: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("buildReviewBriefEntries", () => {
  it("queues pending proposals and open threads whose latest non-system message is from an agent", () => {
    const userAnsweredThread = makeThread({
      id: "thread-user-answered",
      messages: [
        makeMessage({ id: "agent", authorType: "agent", authorName: "Codex", body: "Done." }),
        makeMessage({ id: "user", authorType: "user", authorName: "Reviewer", body: "Thanks." }),
      ],
    });
    const agentThread = makeThread({
      id: "thread-agent",
      messages: [
        makeMessage({ id: "user-first", body: "Can you check this?" }),
        makeMessage({
          id: "agent-last",
          authorType: "agent",
          authorName: "Codex",
          body: "This paragraph needs a stronger claim.",
        }),
      ],
    });
    const resolvedAgentThread = makeThread({
      id: "thread-resolved",
      status: "resolved",
      messages: [
        makeMessage({
          id: "agent-resolved",
          authorType: "agent",
          authorName: "Codex",
          body: "Resolved note.",
        }),
      ],
    });
    const proposal = makeProposal();
    const rejectedProposal = makeProposal({ id: "proposal-rejected", status: "rejected" });

    const entries = buildReviewBriefEntries(
      [documentRecord],
      [userAnsweredThread, agentThread, resolvedAgentThread],
      [proposal, rejectedProposal],
    );

    expect(entries.map((entry) => entry.id)).toEqual(["proposal:proposal-1", "thread:thread-agent"]);
    expect(entries[0].kind).toBe("proposal");
    expect(entries[1].kind).toBe("agent-thread");
  });

  it("marks entries that target an older document hash", () => {
    const proposal = makeProposal({ baseContentHash: "sha256:old" });
    const thread = makeThread({
      id: "thread-old",
      lastReanchorContentHash: "sha256:old",
      messages: [
        makeMessage({
          id: "agent-last",
          authorType: "agent",
          authorName: "Codex",
          body: "Needs review.",
        }),
      ],
    });

    const entries = buildReviewBriefEntries([documentRecord], [thread], [proposal]);

    expect(entries.every((entry) => entry.isOlderVersion)).toBe(true);
  });
});
