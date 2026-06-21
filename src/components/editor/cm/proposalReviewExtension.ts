import { EditorState, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { ReviewChangeSet, ReviewHunk } from "../../../types/proposal";

export interface ProposalReviewEditorState {
  activeHunkId: string | null;
  changeSet: ReviewChangeSet;
  onSelectHunk?: (hunkId: string) => void;
  onToggleHunk?: (hunkId: string) => void;
  selectedHunkIds: string[];
}

export const setProposalReviewEditorState =
  StateEffect.define<ProposalReviewEditorState | null>();

export const proposalReviewDecorationsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = tr.docChanged ? Decoration.none : decorations.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(setProposalReviewEditorState)) {
        return buildProposalReviewDecorationSet(effect.value, tr.state);
      }
    }

    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function buildProposalReviewDecorationSet(
  reviewState: ProposalReviewEditorState | null,
  state: EditorState,
): DecorationSet {
  if (!reviewState || reviewState.changeSet.hunks.length === 0) {
    return Decoration.none;
  }

  const selectedHunkIds = new Set(reviewState.selectedHunkIds);
  const ranges: Range<Decoration>[] = [];

  for (const hunk of reviewState.changeSet.hunks) {
    const displayRange = getProposalHunkDisplayRange(state.doc, hunk);
    if (!displayRange) {
      continue;
    }

    const isActive = reviewState.activeHunkId === hunk.id;
    const isSelected = selectedHunkIds.has(hunk.id);
    const isBlock = isMultiLineDisplayRange(state.doc, displayRange);
    const widget = new ProposalInlineRevisionWidget({
      beforeText: state.doc.sliceString(displayRange.from, displayRange.to),
      hunk,
      isBlock,
      isActive,
      isSelected,
      onSelectHunk: reviewState.onSelectHunk,
    });

    if (displayRange.from < displayRange.to) {
      ranges.push(
        Decoration.replace({
          block: isBlock,
          widget,
        }).range(displayRange.from, displayRange.to),
      );
    } else {
      ranges.push(
        Decoration.widget({
          block: isBlock,
          side: hunk.kind === "insert" ? 1 : -1,
          widget,
        }).range(displayRange.from),
      );
    }
  }

  return Decoration.set(ranges, true);
}

export function getProposalHunkAnchorPosition(
  state: EditorState,
  hunk: ReviewHunk,
): number | null {
  return getProposalHunkDisplayRange(state.doc, hunk)?.from ?? null;
}

interface HunkDisplayRange {
  from: number;
  to: number;
}

function getProposalHunkDisplayRange(doc: Text, hunk: ReviewHunk): HunkDisplayRange | null {
  if (doc.length === 0) {
    return { from: 0, to: 0 };
  }

  const from = getLineStartPosition(doc, hunk.oldRange.startLine);
  if (!hunk.beforeText) {
    return { from, to: from };
  }

  const lastChangedLine = Math.max(hunk.oldRange.startLine, hunk.oldRange.endLine - 1);
  const to =
    lastChangedLine > hunk.oldRange.startLine
      ? getLineBoundaryAfter(doc, lastChangedLine)
      : getLineEndPosition(doc, lastChangedLine);
  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
}

function isMultiLineDisplayRange(doc: Text, range: HunkDisplayRange) {
  if (range.from >= range.to) {
    return false;
  }

  const fromLine = doc.lineAt(range.from).number;
  const toLine = doc.lineAt(Math.max(range.from, range.to - 1)).number;
  return fromLine !== toLine;
}

function getLineStartPosition(doc: Text, lineNumber: number) {
  const clampedLineNumber = clampLineNumber(doc, lineNumber);
  if (clampedLineNumber > doc.lines) {
    return doc.length;
  }

  return doc.line(clampedLineNumber).from;
}

function getLineEndPosition(doc: Text, lineNumber: number) {
  const clampedLineNumber = clampLineNumber(doc, lineNumber);
  if (clampedLineNumber > doc.lines) {
    return doc.length;
  }

  return doc.line(clampedLineNumber).to;
}

function getLineBoundaryAfter(doc: Text, lineNumber: number) {
  const clampedLineNumber = clampLineNumber(doc, lineNumber);
  if (clampedLineNumber >= doc.lines) {
    return doc.length;
  }

  return doc.line(clampedLineNumber + 1).from;
}

function clampLineNumber(doc: Text, lineNumber: number) {
  if (!Number.isFinite(lineNumber)) {
    return 1;
  }

  return Math.max(1, Math.min(Math.floor(lineNumber), doc.lines + 1));
}

function getProposalHunkLabel(kind: ReviewHunk["kind"]) {
  switch (kind) {
    case "insert":
      return "Add";
    case "delete":
      return "Delete";
    case "replace":
    default:
      return "Change";
  }
}

function summarizePreviewText(text: string) {
  const normalized = formatPreviewMarkdownText(text).replace(/\s+$/g, "");
  if (normalized.length <= 900) {
    return normalized || "(blank line)";
  }

  return `${normalized.slice(0, 900)}...`;
}

function formatPreviewMarkdownText(text: string) {
  return text
    .replace(/!\[([^\]\r\n]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]\r\n]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[[^\]\r\n|]+\|([^\]\r\n]+)\]\]/g, "$1")
    .replace(/\[\[([^\]\r\n|]+)\]\]/g, "$1")
    .replace(/\*\*([^*\r\n]+)\*\*/g, "$1")
    .replace(/\*([^*\r\n]+)\*/g, "$1")
    .replace(/__([^_\r\n]+)__/g, "$1")
    .replace(/_([^_\r\n]+)_/g, "$1")
    .replace(/`([^`\r\n]+)`/g, "$1");
}

interface DiffToken {
  text: string;
  type: "equal" | "delete" | "insert" | "replace";
}

const DIFF_TOKEN_PATTERN = /(\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+)/g;
const MAX_INLINE_DIFF_TOKENS = 360;

function tokenizeDiffText(text: string) {
  return Array.from(text.matchAll(DIFF_TOKEN_PATTERN), (match) => match[0]);
}

function diffPreviewTokens(beforeText: string, afterText: string): DiffToken[] {
  const beforeTokens = tokenizeDiffText(summarizePreviewText(beforeText));
  const afterTokens = tokenizeDiffText(summarizePreviewText(afterText));

  if (
    beforeTokens.length === 0 ||
    afterTokens.length === 0 ||
    beforeTokens.length > MAX_INLINE_DIFF_TOKENS ||
    afterTokens.length > MAX_INLINE_DIFF_TOKENS
  ) {
    return fullReplacementTokens(beforeText, afterText);
  }

  const rowWidth = afterTokens.length + 1;
  const table = new Uint16Array((beforeTokens.length + 1) * rowWidth);

  for (let beforeIndex = beforeTokens.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterTokens.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const index = beforeIndex * rowWidth + afterIndex;
      if (beforeTokens[beforeIndex] === afterTokens[afterIndex]) {
        table[index] = table[(beforeIndex + 1) * rowWidth + afterIndex + 1] + 1;
      } else {
        table[index] = Math.max(
          table[(beforeIndex + 1) * rowWidth + afterIndex],
          table[beforeIndex * rowWidth + afterIndex + 1],
        );
      }
    }
  }

  const tokens: DiffToken[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeTokens.length || afterIndex < afterTokens.length) {
    if (
      beforeIndex < beforeTokens.length &&
      afterIndex < afterTokens.length &&
      beforeTokens[beforeIndex] === afterTokens[afterIndex]
    ) {
      tokens.push({ text: beforeTokens[beforeIndex], type: "equal" });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < afterTokens.length &&
      (beforeIndex === beforeTokens.length ||
        table[beforeIndex * rowWidth + afterIndex + 1] >=
          table[(beforeIndex + 1) * rowWidth + afterIndex])
    ) {
      tokens.push({ text: afterTokens[afterIndex], type: "insert" });
      afterIndex += 1;
    } else if (beforeIndex < beforeTokens.length) {
      tokens.push({ text: beforeTokens[beforeIndex], type: "delete" });
      beforeIndex += 1;
    }
  }

  return mergeDiffTokens(tokens);
}

function mergeDiffTokens(tokens: DiffToken[]) {
  const merged: DiffToken[] = [];

  for (const token of tokens) {
    const previous = merged[merged.length - 1];
    if (previous?.type === token.type) {
      previous.text += token.text;
    } else {
      merged.push({ ...token });
    }
  }

  return merged;
}

function getInlineRevisionTokens(hunk: ReviewHunk, beforeText: string): DiffToken[] {
  if (hunk.kind === "delete") {
    return [{ text: summarizePreviewText(beforeText || hunk.beforeText), type: "delete" }];
  }

  if (hunk.kind === "insert") {
    return [{ text: summarizePreviewText(hunk.afterText), type: "insert" }];
  }

  const tokens = diffPreviewTokens(beforeText || hunk.beforeText, hunk.afterText);
  if (shouldRenderAsFullReplacement(tokens, beforeText || hunk.beforeText, hunk.afterText)) {
    return fullReplacementTokens(beforeText || hunk.beforeText, hunk.afterText);
  }

  return tokens;
}

function fullReplacementTokens(beforeText: string, afterText: string): DiffToken[] {
  const tokens: DiffToken[] = [];
  const before = summarizePreviewText(beforeText);
  const after = summarizePreviewText(afterText);

  if (before && before !== "(blank line)") {
    tokens.push({ text: before, type: "delete" });
  }

  if (before && after && before !== "(blank line)" && after !== "(blank line)") {
    tokens.push({ text: " ", type: "equal" });
  }

  if (after && after !== "(blank line)") {
    tokens.push({ text: after, type: "insert" });
  }

  if (tokens.length === 0) {
    return [{ text: "(blank line)", type: "equal" }];
  }

  return tokens;
}

function renderDiffTokens(container: HTMLElement, tokens: DiffToken[]) {
  if (tokens.length === 0) {
    container.textContent = "(blank line)";
    return;
  }

  for (const token of tokens) {
    const span = document.createElement("span");
    span.className = `cm-proposal-inline-token is-${token.type}`;
    span.textContent = token.text;
    container.append(span);
  }
}

function shouldRenderAsFullReplacement(
  tokens: DiffToken[],
  beforeText: string,
  afterText: string,
) {
  const formattedBefore = summarizePreviewText(beforeText);
  const formattedAfter = summarizePreviewText(afterText);
  const largerLength = Math.max(formattedBefore.length, formattedAfter.length);
  if (largerLength < 260) {
    return false;
  }

  const meaningfulTokens = tokens.filter((token) => /\S/.test(token.text));
  const changedTokens = meaningfulTokens.filter((token) => token.type !== "equal");
  const changedLength = changedTokens.reduce((total, token) => total + token.text.trim().length, 0);
  const totalLength = meaningfulTokens.reduce((total, token) => total + token.text.trim().length, 0);
  const changedRatio = totalLength > 0 ? changedLength / totalLength : 0;

  return changedRatio > 0.72;
}

class ProposalInlineRevisionWidget extends WidgetType {
  constructor(
    private readonly options: {
      beforeText: string;
      hunk: ReviewHunk;
      isBlock: boolean;
      isActive: boolean;
      isSelected: boolean;
      onSelectHunk?: (hunkId: string) => void;
    },
  ) {
    super();
  }

  eq(other: ProposalInlineRevisionWidget) {
    return (
      other.options.beforeText === this.options.beforeText &&
      other.options.hunk.id === this.options.hunk.id &&
      other.options.hunk.kind === this.options.hunk.kind &&
      other.options.hunk.beforeText === this.options.hunk.beforeText &&
      other.options.hunk.afterText === this.options.hunk.afterText &&
      other.options.isBlock === this.options.isBlock &&
      other.options.isActive === this.options.isActive &&
      other.options.isSelected === this.options.isSelected
    );
  }

  ignoreEvent() {
    return true;
  }

  toDOM() {
    const { beforeText, hunk, isActive, isBlock, isSelected, onSelectHunk } = this.options;
    const container = document.createElement(isBlock ? "div" : "span");
    container.className = [
      "cm-proposal-inline-revision",
      `is-${hunk.kind}`,
      isBlock ? "is-block" : "is-inline",
      isActive ? "is-active" : "",
      isSelected ? "is-selected" : "is-excluded",
    ]
      .filter(Boolean)
      .join(" ");
    container.dataset.hunkId = hunk.id;

    const content = document.createElement("span");
    content.className = "cm-proposal-inline-content";
    renderDiffTokens(content, getInlineRevisionTokens(hunk, beforeText));

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cm-proposal-inline-chip";
    chip.textContent = String(hunk.index + 1);
    chip.setAttribute("aria-label", `${getProposalHunkLabel(hunk.kind)} ${hunk.index + 1}`);
    chip.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      onSelectHunk?.(hunk.id);
    });

    container.append(content, chip);
    container.addEventListener("mousedown", (event) => {
      if (event.target instanceof Element && event.target.closest(".cm-proposal-inline-chip")) {
        return;
      }

      event.preventDefault();
      onSelectHunk?.(hunk.id);
    });

    return container;
  }
}
