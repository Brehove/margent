import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  buildProposalReviewDecorationSet,
  getProposalHunkAnchorPosition,
} from "../src/components/editor/cm/proposalReviewExtension";
import type { ReviewChangeSet, ReviewHunk } from "../src/types/proposal";

function makeHunk(overrides: Partial<ReviewHunk> = {}): ReviewHunk {
  return {
    afterText: "replacement\n",
    beforeText: "original\n",
    headingPath: [],
    id: "hunk-1",
    index: 0,
    kind: "replace",
    newRange: {
      endByte: 12,
      endLine: 2,
      startByte: 0,
      startLine: 1,
    },
    oldRange: {
      endByte: 9,
      endLine: 2,
      startByte: 0,
      startLine: 1,
    },
    summary: null,
    ...overrides,
  };
}

function makeChangeSet(hunks: ReviewHunk[]): ReviewChangeSet {
  return {
    afterHash: "sha256:after",
    beforeHash: "sha256:before",
    documentId: "doc-1",
    hunks,
    id: "change-set-1",
    source: {
      id: "proposal-1",
      kind: "proposal",
    },
    warnings: [],
  };
}

describe("proposal review CodeMirror decorations", () => {
  it("replaces changed source lines with an inline revision", () => {
    const state = EditorState.create({
      doc: "original\nunchanged\n",
    });
    const hunk = makeHunk();
    const decorations = buildProposalReviewDecorationSet(
      {
        activeHunkId: hunk.id,
        changeSet: makeChangeSet([hunk]),
        selectedHunkIds: [],
      },
      state,
    );
    let widget: { toDOM: () => HTMLElement } | null = null;

    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget) {
        widget = decoration.spec.widget as { toDOM: () => HTMLElement };
      }
    });

    const element = widget?.toDOM();
    expect(element?.className).toContain("cm-proposal-inline-revision");
    expect(element?.className).toContain("is-active");
    expect(element?.className).toContain("is-excluded");
    expect(element?.textContent).toContain("replacement");
  });

  it("uses line numbers instead of UTF-8 byte offsets for editor positions", () => {
    const state = EditorState.create({
      doc: "😀 emoji line\nplain line\n",
    });
    const hunk = makeHunk({
      beforeText: "plain line\n",
      id: "hunk-emoji",
      oldRange: {
        endByte: 999,
        endLine: 3,
        startByte: 999,
        startLine: 2,
      },
    });

    expect(getProposalHunkAnchorPosition(state, hunk)).toBe("😀 emoji line\n".length);
  });

  it("renders insertion hunks as widgets without requiring a source range", () => {
    const onSelectHunk = vi.fn();
    const onToggleHunk = vi.fn();
    const state = EditorState.create({
      doc: "first\nsecond\n",
    });
    const hunk = makeHunk({
      afterText: "inserted\n",
      beforeText: "",
      id: "hunk-insert",
      kind: "insert",
      oldRange: {
        endByte: 6,
        endLine: 2,
        startByte: 6,
        startLine: 2,
      },
    });
    const decorations = buildProposalReviewDecorationSet(
      {
        activeHunkId: null,
        changeSet: makeChangeSet([hunk]),
        onSelectHunk,
        onToggleHunk,
        selectedHunkIds: [hunk.id],
      },
      state,
    );
    let widgetCount = 0;

    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget) {
        widgetCount += 1;
      }
    });

    expect(widgetCount).toBe(1);
  });

  it("renders a direct inline prose revision without card controls", () => {
    const onSelectHunk = vi.fn();
    const onToggleHunk = vi.fn();
    const state = EditorState.create({
      doc: "The threshold context is [[mollick-2025|Real AI Agents]].\n",
    });
    const hunk = makeHunk({
      afterText: "The threshold context is **Real AI Agents and Real Work**.\n",
      beforeText: "The threshold context is [[mollick-2025|Real AI Agents]].\n",
    });
    const decorations = buildProposalReviewDecorationSet(
      {
        activeHunkId: hunk.id,
        changeSet: makeChangeSet([hunk]),
        onSelectHunk,
        onToggleHunk,
        selectedHunkIds: [hunk.id],
      },
      state,
    );
    let widget: { toDOM: () => HTMLElement } | null = null;

    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget) {
        widget = decoration.spec.widget as { toDOM: () => HTMLElement };
      }
    });

    const element = widget?.toDOM();
    expect(element?.className).toContain("cm-proposal-inline-revision");
    expect(element?.querySelector(".cm-proposal-inline-chip")?.textContent).toBe("1");
    expect(element?.querySelector(".cm-proposal-hunk-label")).toBeNull();
    expect(element?.querySelector(".cm-proposal-hunk-action")).toBeNull();
    expect(element?.textContent).toContain("Real AI Agents and Real Work");
    expect(element?.textContent).not.toContain("[[");
    expect(element?.textContent).not.toContain("**");
  });

  it("renders large paragraph rewrites as red deletions plus green insertions", () => {
    const state = EditorState.create({
      doc:
        "Before the role-shift argument can land, the audience needs the chatbot-vs-agentic-AI distinction made explicit. A chatbot answers a turn. An agent runs a loop: it can use tools, move across digital environments, retrieve materials, compare sources, update files, trigger workflows, and act on a user's behalf.\n",
    });
    const hunk = makeHunk({
      afterText:
        "The practical point is simpler: agentic systems do not merely answer; they work across tools, documents, calendars, workflows, and institutional systems. That shift changes what students and faculty need to understand before the rest of the argument can land.\n",
      beforeText: state.doc.toString(),
      oldRange: {
        endByte: 999,
        endLine: 2,
        startByte: 0,
        startLine: 1,
      },
    });
    const decorations = buildProposalReviewDecorationSet(
      {
        activeHunkId: hunk.id,
        changeSet: makeChangeSet([hunk]),
        selectedHunkIds: [hunk.id],
      },
      state,
    );
    let widget: { toDOM: () => HTMLElement } | null = null;

    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget) {
        widget = decoration.spec.widget as { toDOM: () => HTMLElement };
      }
    });

    const element = widget?.toDOM();
    expect(element?.querySelector(".cm-proposal-inline-token.is-delete")?.textContent).toContain(
      "the audience needs the chatbot-vs-agentic-AI distinction",
    );
    expect(element?.querySelector(".cm-proposal-inline-token.is-insert")?.textContent).toContain(
      "agentic systems do not merely answer",
    );
    expect(element?.querySelector(".cm-proposal-inline-token.is-replace")).toBeNull();
  });
});
