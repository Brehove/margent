import { describe, it, expect, beforeEach } from "vitest";
import { useThreadStore } from "../src/stores/threadStore";
import type { ThreadRecord, AnchorRecord, MessageRecord } from "../src/types/thread";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const stubAnchor: AnchorRecord = {
  quote: "some quote",
  prefixContext: "",
  suffixContext: "",
  startOffsetUtf16: 0,
  endOffsetUtf16: 10,
  startLine: 1,
  startColumn: 0,
  endLine: 1,
  endColumn: 10,
  headingPath: [],
  blockFingerprint: "",
  baseContentHash: "",
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
    createdBy: "Alice",
    title: "Thread",
    tags: [],
    anchor: stubAnchor,
    messages: [],
    linkedProposalIds: [],
    providerSessions: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  useThreadStore.getState().reset();
});

/* ---------- setThreads() merge logic ---------- */

describe("setThreads() merge logic", () => {
  it("1 - fresh load: populates an empty store", () => {
    const t1 = makeThread({ id: "t-1", updatedAt: "2026-01-01T00:00:00Z" });
    const t2 = makeThread({ id: "t-2", updatedAt: "2026-01-02T00:00:00Z" });

    useThreadStore.getState().setThreads([t1, t2]);

    const { threads } = useThreadStore.getState();
    expect(threads).toHaveLength(2);
    expect(threads.map((t) => t.id)).toContain("t-1");
    expect(threads.map((t) => t.id)).toContain("t-2");
  });

  it("2 - merge preserves existing messages when incoming thread has empty messages", () => {
    const existingMsg = makeMessage({ id: "msg-1", threadId: "t-1", body: "Existing message" });
    const threadWithMessages = makeThread({ id: "t-1", messages: [existingMsg] });

    useThreadStore.getState().setThreads([threadWithMessages]);
    expect(useThreadStore.getState().threads[0].messages).toHaveLength(1);

    // Incoming thread has same id but empty messages (e.g. summary from backend)
    const incomingEmpty = makeThread({ id: "t-1", messages: [], title: "Updated title" });
    useThreadStore.getState().setThreads([incomingEmpty]);

    const { threads } = useThreadStore.getState();
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe("Updated title");
    expect(threads[0].messages).toHaveLength(1);
    expect(threads[0].messages[0].id).toBe("msg-1");
  });

  it("3 - merge replaces messages when incoming thread has messages", () => {
    const oldMsg = makeMessage({ id: "msg-old", threadId: "t-1", body: "Old" });
    const threadOld = makeThread({ id: "t-1", messages: [oldMsg] });

    useThreadStore.getState().setThreads([threadOld]);

    const newMsg = makeMessage({ id: "msg-new", threadId: "t-1", body: "New" });
    const threadNew = makeThread({ id: "t-1", messages: [newMsg] });
    useThreadStore.getState().setThreads([threadNew]);

    const { threads } = useThreadStore.getState();
    expect(threads[0].messages).toHaveLength(1);
    expect(threads[0].messages[0].id).toBe("msg-new");
  });

  it("4 - merge with no existing: new threads with empty messages are accepted as-is", () => {
    const t = makeThread({ id: "t-new", messages: [] });
    useThreadStore.getState().setThreads([t]);

    const { threads } = useThreadStore.getState();
    expect(threads).toHaveLength(1);
    expect(threads[0].messages).toHaveLength(0);
  });

  it("5 - threads are sorted by updatedAt descending after merge", () => {
    const t1 = makeThread({ id: "t-1", updatedAt: "2026-01-01T00:00:00Z" });
    const t2 = makeThread({ id: "t-2", updatedAt: "2026-01-03T00:00:00Z" });
    const t3 = makeThread({ id: "t-3", updatedAt: "2026-01-02T00:00:00Z" });

    useThreadStore.getState().setThreads([t1, t2, t3]);

    const ids = useThreadStore.getState().threads.map((t) => t.id);
    expect(ids).toEqual(["t-2", "t-3", "t-1"]);
  });

  it("6 - selectedThreadId is preserved if thread still exists after merge", () => {
    const t1 = makeThread({ id: "t-1" });
    const t2 = makeThread({ id: "t-2" });

    useThreadStore.getState().setThreads([t1, t2]);
    useThreadStore.getState().selectThread("t-2");
    expect(useThreadStore.getState().selectedThreadId).toBe("t-2");

    // Re-set threads that still include t-2
    useThreadStore.getState().setThreads([t1, t2]);
    expect(useThreadStore.getState().selectedThreadId).toBe("t-2");
  });

  it("7 - selectedThreadId is cleared if thread no longer exists after merge", () => {
    const t1 = makeThread({ id: "t-1" });
    const t2 = makeThread({ id: "t-2" });

    useThreadStore.getState().setThreads([t1, t2]);
    useThreadStore.getState().selectThread("t-2");
    expect(useThreadStore.getState().selectedThreadId).toBe("t-2");

    // Re-set threads without t-2
    useThreadStore.getState().setThreads([t1]);
    expect(useThreadStore.getState().selectedThreadId).toBeNull();
  });
});

/* ---------- upsertThread() ---------- */

describe("upsertThread()", () => {
  it("8 - inserts new thread and selects it", () => {
    const t = makeThread({ id: "t-new" });
    useThreadStore.getState().upsertThread(t);

    const state = useThreadStore.getState();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].id).toBe("t-new");
    expect(state.selectedThreadId).toBe("t-new");
  });

  it("9 - updates existing thread in place", () => {
    const t = makeThread({ id: "t-1", title: "Original" });
    useThreadStore.getState().setThreads([t]);

    const updated = makeThread({ id: "t-1", title: "Updated" });
    useThreadStore.getState().upsertThread(updated);

    const state = useThreadStore.getState();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].title).toBe("Updated");
  });

  it("10 - updated thread moves to top of list (most recently updated)", () => {
    const t1 = makeThread({ id: "t-1", updatedAt: "2026-01-03T00:00:00Z" });
    const t2 = makeThread({ id: "t-2", updatedAt: "2026-01-02T00:00:00Z" });
    const t3 = makeThread({ id: "t-3", updatedAt: "2026-01-01T00:00:00Z" });

    useThreadStore.getState().setThreads([t1, t2, t3]);
    expect(useThreadStore.getState().threads[0].id).toBe("t-1");

    // Update t-3 with a newer timestamp so it sorts first
    const t3Updated = makeThread({ id: "t-3", updatedAt: "2026-01-04T00:00:00Z" });
    useThreadStore.getState().upsertThread(t3Updated);

    const ids = useThreadStore.getState().threads.map((t) => t.id);
    expect(ids[0]).toBe("t-3");
  });
});

/* ---------- removeThread() ---------- */

describe("removeThread()", () => {
  it("11 - removes thread from list", () => {
    const t1 = makeThread({ id: "t-1" });
    const t2 = makeThread({ id: "t-2" });
    useThreadStore.getState().setThreads([t1, t2]);

    useThreadStore.getState().removeThread("t-1");

    const ids = useThreadStore.getState().threads.map((t) => t.id);
    expect(ids).toEqual(["t-2"]);
  });

  it("12 - if removed thread was selected, auto-selects first remaining", () => {
    const t1 = makeThread({ id: "t-1", updatedAt: "2026-01-02T00:00:00Z" });
    const t2 = makeThread({ id: "t-2", updatedAt: "2026-01-01T00:00:00Z" });
    useThreadStore.getState().setThreads([t1, t2]);
    useThreadStore.getState().selectThread("t-1");

    useThreadStore.getState().removeThread("t-1");

    expect(useThreadStore.getState().selectedThreadId).toBe("t-2");
  });

  it("13 - if removed thread was not selected, selection unchanged", () => {
    const t1 = makeThread({ id: "t-1" });
    const t2 = makeThread({ id: "t-2" });
    useThreadStore.getState().setThreads([t1, t2]);
    useThreadStore.getState().selectThread("t-1");

    useThreadStore.getState().removeThread("t-2");

    expect(useThreadStore.getState().selectedThreadId).toBe("t-1");
  });
});

/* ---------- selectThread() ---------- */

describe("selectThread()", () => {
  it("14 - sets selectedThreadId", () => {
    useThreadStore.getState().selectThread("t-42");
    expect(useThreadStore.getState().selectedThreadId).toBe("t-42");
  });

  it("15 - increments selectionRevision", () => {
    const before = useThreadStore.getState().selectionRevision;
    useThreadStore.getState().selectThread("t-1");
    expect(useThreadStore.getState().selectionRevision).toBe(before + 1);

    useThreadStore.getState().selectThread("t-2");
    expect(useThreadStore.getState().selectionRevision).toBe(before + 2);
  });
});

/* ---------- reset() ---------- */

describe("reset()", () => {
  it("16 - clears all state to defaults", () => {
    // Populate the store
    const t = makeThread({ id: "t-1" });
    useThreadStore.getState().setThreads([t]);
    useThreadStore.getState().selectThread("t-1");
    useThreadStore.getState().setErrorMessage("something broke");
    useThreadStore.getState().setIsLoading(true);
    useThreadStore.getState().setIsSaving(true);

    // Verify non-default state
    expect(useThreadStore.getState().threads).toHaveLength(1);
    expect(useThreadStore.getState().selectedThreadId).toBe("t-1");

    useThreadStore.getState().reset();

    const state = useThreadStore.getState();
    expect(state.threads).toEqual([]);
    expect(state.selectedThreadId).toBeNull();
    expect(state.selectionRevision).toBe(0);
    expect(state.errorMessage).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.isSaving).toBe(false);
  });
});

/* ---------- Edge cases ---------- */

describe("Edge cases", () => {
  it("17 - setThreads with empty array clears everything", () => {
    const t1 = makeThread({ id: "t-1" });
    const t2 = makeThread({ id: "t-2" });
    useThreadStore.getState().setThreads([t1, t2]);
    useThreadStore.getState().selectThread("t-1");

    useThreadStore.getState().setThreads([]);

    const state = useThreadStore.getState();
    expect(state.threads).toEqual([]);
    expect(state.selectedThreadId).toBeNull();
  });

  it("18 - upsert into empty store", () => {
    expect(useThreadStore.getState().threads).toEqual([]);

    const t = makeThread({ id: "t-first" });
    useThreadStore.getState().upsertThread(t);

    const state = useThreadStore.getState();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].id).toBe("t-first");
    expect(state.selectedThreadId).toBe("t-first");
  });

  it("19 - remove from single-item store leaves empty list", () => {
    const t = makeThread({ id: "t-only" });
    useThreadStore.getState().setThreads([t]);
    useThreadStore.getState().selectThread("t-only");

    useThreadStore.getState().removeThread("t-only");

    const state = useThreadStore.getState();
    expect(state.threads).toEqual([]);
    expect(state.selectedThreadId).toBeNull();
  });
});
