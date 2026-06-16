import { describe, expect, it } from "vitest";
import { collectReviewNotificationItems } from "../src/lib/reviewNotifications";
import type { AnchorRecord, MessageRecord, ThreadRecord } from "../src/types/thread";

const anchor: AnchorRecord = {
  baseContentHash: "sha256:base",
  blockFingerprint: "sha256:block",
  confidence: 1,
  endColumn: 6,
  endLine: 1,
  endOffsetUtf16: 5,
  headingPath: [],
  prefixContext: "",
  quote: "Alpha",
  startColumn: 1,
  startLine: 1,
  startOffsetUtf16: 0,
  state: "attached",
  suffixContext: "",
};

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    adapterId: null,
    agentId: null,
    authorName: "Codex",
    authorType: "agent",
    body: "Agent response",
    createdAt: "2026-06-11T00:00:00Z",
    id: "msg-agent",
    kind: "reply",
    replyToMessageId: null,
    threadId: "thread-1",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    anchor,
    createdAt: "2026-06-11T00:00:00Z",
    createdBy: "user",
    documentId: "doc-1",
    id: "thread-1",
    linkedProposalIds: [],
    messages: [],
    providerSessions: {},
    schemaVersion: 6,
    status: "open",
    tags: [],
    title: "Thread title",
    updatedAt: "2026-06-11T00:00:00Z",
    ...overrides,
  };
}

describe("review notification diffs", () => {
  it("emits notifications for new agent messages", () => {
    const previousThread = makeThread({
      messages: [makeMessage({ id: "msg-existing" })],
    });
    const nextThread = makeThread({
      messages: [
        makeMessage({ id: "msg-existing" }),
        makeMessage({
          authorName: "Claude",
          body: "A fresh reply from the external agent.",
          id: "msg-new",
        }),
      ],
    });

    const items = collectReviewNotificationItems({
      documentRelativePath: "draft.md",
      nextThreads: [nextThread],
      previousThreads: [previousThread],
      workspaceRoot: "/tmp/margent",
    });

    expect(items).toEqual([
      {
        body: "A fresh reply from the external agent.",
        documentRelativePath: "draft.md",
        threadId: "thread-1",
        title: "Claude replied: Thread title",
        workspaceRoot: "/tmp/margent",
      },
    ]);
  });

  it("ignores new user replies", () => {
    const nextThread = makeThread({
      messages: [
        makeMessage({
          authorName: "Reviewer",
          authorType: "user",
          body: "A human reply.",
          id: "msg-user",
        }),
      ],
    });

    const items = collectReviewNotificationItems({
      documentRelativePath: "draft.md",
      nextThreads: [nextThread],
      previousThreads: [makeThread()],
      workspaceRoot: "/tmp/margent",
    });

    expect(items).toEqual([]);
  });

  it("emits notifications for newly linked proposals", () => {
    const previousThread = makeThread({ linkedProposalIds: ["proposal-old"] });
    const nextThread = makeThread({
      linkedProposalIds: ["proposal-old", "proposal-new"],
    });

    const items = collectReviewNotificationItems({
      documentRelativePath: "draft.md",
      nextThreads: [nextThread],
      previousThreads: [previousThread],
      workspaceRoot: "/tmp/margent",
    });

    expect(items).toEqual([
      {
        body: "New proposal proposal-new",
        documentRelativePath: "draft.md",
        threadId: "thread-1",
        title: "Revision proposal: Thread title",
        workspaceRoot: "/tmp/margent",
      },
    ]);
  });
});
