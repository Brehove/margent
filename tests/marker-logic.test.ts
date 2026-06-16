import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import type { AnchorRecord, ThreadRecord } from "../src/types/thread";
import {
  buildThreadDecorationSet,
  buildThreadPresentation,
  getNextSelectedThreadId,
  mapThreadPresentation,
  mergeThreadState,
  threadStatePriority,
  formatAnchorState,
  type ThreadPresentation,
} from "../src/components/editor/useCodeMirror";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeAnchor(overrides: Partial<AnchorRecord> = {}): AnchorRecord {
  return {
    quote: "hello world",
    prefixContext: "",
    suffixContext: "",
    startOffsetUtf16: 0,
    endOffsetUtf16: 11,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 12,
    headingPath: [],
    blockFingerprint: "sha256:placeholder",
    baseContentHash: "sha256:placeholder",
    state: "attached",
    confidence: 1,
    ...overrides,
  };
}

function makeThread(
  id: string,
  anchorOverrides: Partial<AnchorRecord> = {},
  threadOverrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  return {
    schemaVersion: 1,
    id,
    documentId: "doc_test",
    status: "open",
    createdAt: "2026-03-17T10:00:00Z",
    updatedAt: "2026-03-17T10:00:00Z",
    createdBy: "tester",
    title: "Test thread",
    tags: [],
    anchor: makeAnchor(anchorOverrides),
    messages: [],
    linkedProposalIds: [],
    providerSessions: {},
    ...threadOverrides,
  };
}

/** Create a minimal CodeMirror EditorState from a string. */
function makeEditorState(content: string): EditorState {
  return EditorState.create({ doc: content });
}

// ===========================================================================
// 1. buildThreadPresentation()
// ===========================================================================

describe("buildThreadPresentation", () => {
  it("single thread produces one placement with label '1' at the anchor start", () => {
    const content = "hello world";
    const thread = makeThread("t1", {
      quote: "hello world",
      startOffsetUtf16: 0,
      endOffsetUtf16: 11,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    expect(result.placements).toHaveLength(1);
    expect(result.placements[0].label).toBe("1");
    expect(result.placements[0].threadIds).toEqual(["t1"]);
    expect(result.placements[0].anchorFrom).toBe(0);
    expect(result.placements[0].position).toBe(0);
  });

  it("two threads on different lines produce two separate placements", () => {
    const content = "line one\nline two";
    const thread1 = makeThread("t1", {
      quote: "line one",
      startOffsetUtf16: 0,
      endOffsetUtf16: 8,
    });
    const thread2 = makeThread("t2", {
      quote: "line two",
      startOffsetUtf16: 9,
      endOffsetUtf16: 17,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread1, thread2], state);

    expect(result.placements).toHaveLength(2);
    expect(result.placements[0].threadIds).toEqual(["t1"]);
    expect(result.placements[1].threadIds).toEqual(["t2"]);
  });

  it("two threads on the SAME logical line produce separate placements when they start at different offsets", () => {
    const content = "hello world foo bar";
    const thread1 = makeThread("t1", {
      quote: "hello",
      startOffsetUtf16: 0,
      endOffsetUtf16: 5,
    });
    const thread2 = makeThread("t2", {
      quote: "world",
      startOffsetUtf16: 6,
      endOffsetUtf16: 11,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread1, thread2], state);

    expect(result.placements).toHaveLength(2);
    expect(result.placements[0].threadIds).toEqual(["t1"]);
    expect(result.placements[1].threadIds).toEqual(["t2"]);
  });

  it("threads with the same anchor start still merge into one placement", () => {
    const content = "hello world foo bar";
    const thread1 = makeThread("t1", {
      quote: "hello",
      startOffsetUtf16: 0,
      endOffsetUtf16: 5,
    });
    const thread2 = makeThread("t2", {
      quote: "hello world",
      startOffsetUtf16: 0,
      endOffsetUtf16: 11,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread1, thread2], state);

    expect(result.placements).toHaveLength(1);
    expect(result.placements[0].label).toBe("2");
    expect(result.placements[0].threadIds).toEqual(["t1", "t2"]);
  });

  it("state merging: merged state is highest priority when threads share an anchor start", () => {
    const content = "hello world foo bar";
    const thread1 = makeThread("t1", {
      quote: "hello",
      startOffsetUtf16: 0,
      endOffsetUtf16: 5,
      state: "attached",
    });
    const thread2 = makeThread("t2", {
      quote: "hello world",
      startOffsetUtf16: 0,
      endOffsetUtf16: 11,
      state: "needs_review",
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread1, thread2], state);

    expect(result.placements[0].state).toBe("needs_review");
  });

  it("selected thread ID produces a range entry in rangesByThreadId", () => {
    const content = "hello world";
    const thread = makeThread("t1", {
      quote: "hello world",
      startOffsetUtf16: 0,
      endOffsetUtf16: 11,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    expect(result.rangesByThreadId.has("t1")).toBe(true);
    const range = result.rangesByThreadId.get("t1")!;
    expect(range.from).toBe(0);
    expect(range.to).toBe(11);
  });

  it("no matching thread means empty ranges for that ID", () => {
    const content = "hello world";
    const thread = makeThread("t1", {
      quote: "hello world",
      startOffsetUtf16: 0,
      endOffsetUtf16: 11,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    expect(result.rangesByThreadId.has("nonexistent")).toBe(false);
  });

  it("thread with from === to (zero-length range) does not get a range entry", () => {
    const content = "hello world";
    // A degenerate anchor where start == end
    const thread = makeThread("t1", {
      quote: "",
      startOffsetUtf16: 5,
      endOffsetUtf16: 5,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    // from === to, so the condition `from < to` is false => no range entry
    expect(result.rangesByThreadId.has("t1")).toBe(false);
    // But it still gets a placement
    expect(result.placements).toHaveLength(1);
  });

  it("document-level threads do not produce editor rail markers", () => {
    const content = "hello world";
    const documentThread = makeThread(
      "doc-thread",
      {
        confidence: 0,
        endOffsetUtf16: 0,
        kind: "document",
        quote: "",
        startOffsetUtf16: 0,
        state: "detached",
      },
      {
        tags: ["document"],
      },
    );
    const passageThread = makeThread("passage-thread", {
      quote: "hello",
      startOffsetUtf16: 0,
      endOffsetUtf16: 5,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([documentThread, passageThread], state);

    expect(result.placements).toHaveLength(1);
    expect(result.placements[0].label).toBe("1");
    expect(result.placements[0].threadIds).toEqual(["passage-thread"]);
    expect(result.rangesByThreadId.has("doc-thread")).toBe(false);
  });

  it("resolved threads do not produce rail placements or highlight ranges", () => {
    const content = "hello world";
    const thread = makeThread(
      "resolved-thread",
      {
        quote: "hello",
        startOffsetUtf16: 0,
        endOffsetUtf16: 5,
      },
      { status: "resolved" },
    );
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    expect(result.placements).toHaveLength(0);
    expect(result.rangesByThreadId.has("resolved-thread")).toBe(false);
  });
});

// ===========================================================================
// 2. getNextSelectedThreadId()
// ===========================================================================

describe("getNextSelectedThreadId", () => {
  it("click marker with single thread ID: selects that thread", () => {
    expect(getNextSelectedThreadId(["t1"], null)).toBe("t1");
  });

  it("click marker with single thread ID that is already selected: deselects", () => {
    expect(getNextSelectedThreadId(["t1"], "t1")).toBeNull();
  });

  it("click marker with multiple thread IDs, none selected: selects first", () => {
    expect(getNextSelectedThreadId(["t1", "t2", "t3"], null)).toBe("t1");
  });

  it("click marker with multiple thread IDs, first is selected: cycles to second", () => {
    expect(getNextSelectedThreadId(["t1", "t2", "t3"], "t1")).toBe("t2");
  });

  it("click marker with multiple thread IDs, last is selected: wraps to first", () => {
    expect(getNextSelectedThreadId(["t1", "t2", "t3"], "t3")).toBe("t1");
  });

  it("click marker with multiple thread IDs, middle is selected: cycles to next", () => {
    expect(getNextSelectedThreadId(["t1", "t2", "t3"], "t2")).toBe("t3");
  });

  it("empty thread IDs returns null", () => {
    expect(getNextSelectedThreadId([], null)).toBeNull();
  });

  it("deduplicates thread IDs before cycling", () => {
    // If the same thread ID appears twice, it should be treated as a single entry
    expect(getNextSelectedThreadId(["t1", "t1"], null)).toBe("t1");
    expect(getNextSelectedThreadId(["t1", "t1"], "t1")).toBeNull();
  });
});

// ===========================================================================
// 3. mergeThreadState()
// ===========================================================================

describe("mergeThreadState", () => {
  it("needs_review beats everything", () => {
    expect(mergeThreadState("attached", "needs_review")).toBe("needs_review");
    expect(mergeThreadState("shifted", "needs_review")).toBe("needs_review");
    expect(mergeThreadState("fuzzy", "needs_review")).toBe("needs_review");
    expect(mergeThreadState("detached", "needs_review")).toBe("needs_review");
  });

  it("detached beats fuzzy, shifted, attached", () => {
    expect(mergeThreadState("attached", "detached")).toBe("detached");
    expect(mergeThreadState("shifted", "detached")).toBe("detached");
    expect(mergeThreadState("fuzzy", "detached")).toBe("detached");
  });

  it("fuzzy beats shifted and attached", () => {
    expect(mergeThreadState("attached", "fuzzy")).toBe("fuzzy");
    expect(mergeThreadState("shifted", "fuzzy")).toBe("fuzzy");
  });

  it("same state returns that state", () => {
    expect(mergeThreadState("attached", "attached")).toBe("attached");
    expect(mergeThreadState("fuzzy", "fuzzy")).toBe("fuzzy");
    expect(mergeThreadState("needs_review", "needs_review")).toBe("needs_review");
  });

  it("lower priority next state does not override higher priority current state", () => {
    expect(mergeThreadState("needs_review", "attached")).toBe("needs_review");
    expect(mergeThreadState("detached", "attached")).toBe("detached");
    expect(mergeThreadState("fuzzy", "shifted")).toBe("fuzzy");
  });
});

// ===========================================================================
// 4. threadStatePriority()
// ===========================================================================

describe("threadStatePriority", () => {
  it("returns correct numeric priority for each state", () => {
    expect(threadStatePriority("attached")).toBe(0);
    expect(threadStatePriority("shifted")).toBe(1);
    expect(threadStatePriority("fuzzy")).toBe(2);
    expect(threadStatePriority("detached")).toBe(3);
    expect(threadStatePriority("needs_review")).toBe(4);
  });

  it("needs_review has the highest priority", () => {
    const allStates = ["attached", "shifted", "fuzzy", "detached", "needs_review"] as const;
    const maxPriority = Math.max(...allStates.map(threadStatePriority));
    expect(threadStatePriority("needs_review")).toBe(maxPriority);
  });

  it("attached has the lowest priority", () => {
    const allStates = ["attached", "shifted", "fuzzy", "detached", "needs_review"] as const;
    const minPriority = Math.min(...allStates.map(threadStatePriority));
    expect(threadStatePriority("attached")).toBe(minPriority);
  });
});

// ===========================================================================
// 5. formatAnchorState()
// ===========================================================================

describe("formatAnchorState", () => {
  it("'attached' returns 'Attached'", () => {
    expect(formatAnchorState("attached")).toBe("Attached");
  });

  it("'needs_review' returns 'Needs review'", () => {
    expect(formatAnchorState("needs_review")).toBe("Needs review");
  });

  it("'detached' returns 'Detached'", () => {
    expect(formatAnchorState("detached")).toBe("Detached");
  });

  it("'shifted' returns 'Shifted'", () => {
    expect(formatAnchorState("shifted")).toBe("Shifted");
  });

  it("'fuzzy' returns 'Fuzzy'", () => {
    expect(formatAnchorState("fuzzy")).toBe("Fuzzy");
  });
});

// ===========================================================================
// 6. Selected thread highlight range
// ===========================================================================

describe("Selected thread highlight range", () => {
  it("when selectedThreadId matches a resolved anchor, its range is in output", () => {
    const content = "hello world";
    const thread = makeThread("t1", {
      quote: "hello world",
      startOffsetUtf16: 0,
      endOffsetUtf16: 11,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    expect(result.rangesByThreadId.has("t1")).toBe(true);
    const range = result.rangesByThreadId.get("t1")!;
    expect(range.from).toBeDefined();
    expect(range.to).toBeDefined();
  });

  it("when selectedThreadId does not match any anchor, ranges map has no entry for it", () => {
    const content = "hello world";
    const thread = makeThread("t1", {
      quote: "hello world",
      startOffsetUtf16: 0,
      endOffsetUtf16: 11,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    expect(result.rangesByThreadId.has("nonexistent")).toBe(false);
  });

  it("range from/to values match the resolved anchor offsets", () => {
    const content = "abc hello world xyz";
    const thread = makeThread("t1", {
      quote: "hello world",
      startOffsetUtf16: 4,
      endOffsetUtf16: 15,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    const range = result.rangesByThreadId.get("t1")!;
    expect(range.from).toBe(4);
    expect(range.to).toBe(15);
  });

  it("multi-line thread range spans correct offsets", () => {
    const content = "first line\nsecond line\nthird line";
    const thread = makeThread("t1", {
      quote: "second line",
      startOffsetUtf16: 11,
      endOffsetUtf16: 22,
    });
    const state = makeEditorState(content);
    const result = buildThreadPresentation([thread], state);

    const range = result.rangesByThreadId.get("t1")!;
    expect(range.from).toBe(11);
    expect(range.to).toBe(22);
    expect(content.slice(range.from, range.to)).toBe("second line");
  });
});

describe("thread anchor decoration states", () => {
  it("decorates every open spatial anchor and marks only the selected one active", () => {
    const content = "first anchor\nsecond anchor";
    const firstStart = content.indexOf("first");
    const firstEnd = firstStart + "first anchor".length;
    const secondStart = content.indexOf("second");
    const secondEnd = secondStart + "second anchor".length;
    const state = makeEditorState(content);
    const presentation = buildThreadPresentation(
      [
        makeThread("t1", {
          quote: "first anchor",
          startOffsetUtf16: firstStart,
          endOffsetUtf16: firstEnd,
        }),
        makeThread("t2", {
          quote: "second anchor",
          startOffsetUtf16: secondStart,
          endOffsetUtf16: secondEnd,
        }),
      ],
      state,
    );
    const decorations = buildThreadDecorationSet(presentation, "t2");
    const classes: string[] = [];

    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      classes.push(String(decoration.spec.class ?? ""));
    });

    expect(classes).toEqual(["cm-thread-anchor", "cm-thread-anchor is-active"]);
  });
});

// ===========================================================================
// 7. mapThreadPresentation()
// ===========================================================================

describe("mapThreadPresentation", () => {
  it("maps placements and ranges forward when text is inserted before them", () => {
    const threadPresentation: ThreadPresentation = {
      placements: [
        {
          anchorFrom: 4,
          confidence: 1,
          label: "1",
          ordinals: [1],
          position: 11,
          state: "attached",
          threadIds: ["t1"],
        },
      ],
      rangesByThreadId: new Map([
        [
          "t1",
          {
            confidence: 1,
            from: 4,
            ordinal: 1,
            state: "attached",
            to: 9,
          },
        ],
      ]),
    };
    const state = makeEditorState("hello world");
    const changes = state.update({
      changes: {
        from: 0,
        insert: "abc",
      },
    }).changes;

    const mapped = mapThreadPresentation(threadPresentation, changes);

    expect(mapped.placements[0].anchorFrom).toBe(7);
    expect(mapped.placements[0].position).toBe(14);
    expect(mapped.rangesByThreadId.get("t1")).toMatchObject({
      from: 7,
      to: 12,
    });
  });

  it("keeps placements and ranges aligned across repeated edits above an anchor", () => {
    let state = makeEditorState("alpha\nbeta\ngamma");
    let presentation: ThreadPresentation = {
      placements: [
        {
          anchorFrom: 6,
          confidence: 1,
          label: "1",
          ordinals: [1],
          position: 6,
          state: "attached",
          threadIds: ["t1"],
        },
      ],
      rangesByThreadId: new Map([
        [
          "t1",
          {
            confidence: 1,
            from: 6,
            ordinal: 1,
            state: "attached",
            to: 10,
          },
        ],
      ]),
    };

    const insertIntro = state.update({
      changes: {
        from: 0,
        insert: "intro\n",
      },
    });
    state = insertIntro.state;
    presentation = mapThreadPresentation(presentation, insertIntro.changes);

    const insertMore = state.update({
      changes: {
        from: 6,
        insert: "more\n",
      },
    });
    state = insertMore.state;
    presentation = mapThreadPresentation(presentation, insertMore.changes);

    const removeIntro = state.update({
      changes: {
        from: 0,
        to: 6,
        insert: "",
      },
    });
    presentation = mapThreadPresentation(presentation, removeIntro.changes);

    expect(presentation.placements[0]).toMatchObject({
      anchorFrom: 11,
      position: 11,
    });
    expect(presentation.rangesByThreadId.get("t1")).toMatchObject({
      from: 11,
      to: 15,
    });
  });

  it("drops zero-length ranges after destructive edits", () => {
    const threadPresentation: ThreadPresentation = {
      placements: [
        {
          anchorFrom: 4,
          confidence: 1,
          label: "1",
          ordinals: [1],
          position: 11,
          state: "attached",
          threadIds: ["t1"],
        },
      ],
      rangesByThreadId: new Map([
        [
          "t1",
          {
            confidence: 1,
            from: 4,
            ordinal: 1,
            state: "attached",
            to: 9,
          },
        ],
      ]),
    };
    const state = makeEditorState("hello world");
    const changes = state.update({
      changes: {
        from: 4,
        to: 9,
        insert: "",
      },
    }).changes;

    const mapped = mapThreadPresentation(threadPresentation, changes);

    expect(mapped.placements[0].anchorFrom).toBe(4);
    expect(mapped.rangesByThreadId.has("t1")).toBe(false);
    expect(mapped.placements[0].position).toBe(6);
  });
});
