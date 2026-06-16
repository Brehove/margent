import type { EditorSelectionSnapshot, FootnoteAnchorMetadata } from "../types/thread";

export type FootnoteSelectionKind = "footnote_reference" | "footnote_definition";

export interface FootnoteSelectionMatch {
  kind: FootnoteSelectionKind;
  label: string;
  occurrence: number;
  tokenStartOffsetUtf16: number;
  tokenEndOffsetUtf16: number;
  blockStartOffsetUtf16: number;
  blockEndOffsetUtf16: number;
  startLine: number;
  endLine: number;
}

export interface FootnoteAnchorSemanticMatch {
  kind: FootnoteSelectionKind;
  footnote: FootnoteAnchorMetadata;
}

const FOOTNOTE_TOKEN_RE = /\[\^([^\]\r\n]+)\]/g;
const FOOTNOTE_DEFINITION_RE = /^( {0,3})\[\^([^\]\r\n]+)\]:([ \t]?.*)$/gm;

export function classifyFootnoteSelection(
  content: string,
  selection: EditorSelectionSnapshot,
): FootnoteSelectionMatch | null {
  for (const definition of collectFootnoteDefinitions(content)) {
    if (rangesOverlap(selection.startOffsetUtf16, selection.endOffsetUtf16, definition)) {
      return definition;
    }
  }

  for (const reference of collectFootnoteReferences(content)) {
    if (rangesOverlap(selection.startOffsetUtf16, selection.endOffsetUtf16, reference)) {
      return reference;
    }
  }

  return null;
}

export function resolveFootnoteAnchorSemantic(
  content: string,
  selection: EditorSelectionSnapshot,
): FootnoteAnchorSemanticMatch | null {
  const match = classifyFootnoteSelection(content, selection);

  if (!match) {
    return null;
  }

  if (match.kind === "footnote_reference") {
    const isWithinToken =
      selection.startOffsetUtf16 >= match.tokenStartOffsetUtf16 &&
      selection.endOffsetUtf16 <= match.tokenEndOffsetUtf16;

    if (!isWithinToken) {
      return null;
    }
  }

  const isWithinBlock =
    selection.startOffsetUtf16 >= match.blockStartOffsetUtf16 &&
    selection.endOffsetUtf16 <= match.blockEndOffsetUtf16;

  if (!isWithinBlock) {
    return null;
  }

  return {
    kind: match.kind,
    footnote: {
      label: match.label,
      occurrence: match.occurrence,
    },
  };
}

export function collectFootnoteDefinitions(content: string): FootnoteSelectionMatch[] {
  const lineStarts = buildLineStarts(content);
  const occurrenceByLabel = new Map<string, number>();
  const matches: FootnoteSelectionMatch[] = [];

  for (const match of content.matchAll(FOOTNOTE_DEFINITION_RE)) {
    const indent = match[1] ?? "";
    const label = match[2] ?? "";
    const definitionStart = match.index ?? 0;
    const tokenStart = definitionStart + indent.length;
    const tokenEnd = tokenStart + `[${"^"}${label}]:`.length;
    const definitionEnd = findDefinitionBlockEnd(content, definitionStart);
    const occurrence = (occurrenceByLabel.get(label) ?? 0) + 1;
    occurrenceByLabel.set(label, occurrence);

    matches.push({
      kind: "footnote_definition",
      label,
      occurrence,
      tokenStartOffsetUtf16: tokenStart,
      tokenEndOffsetUtf16: tokenEnd,
      blockStartOffsetUtf16: definitionStart,
      blockEndOffsetUtf16: definitionEnd,
      startLine: offsetToLineNumber(lineStarts, definitionStart),
      endLine: offsetToLineNumber(lineStarts, Math.max(definitionEnd - 1, definitionStart)),
    });
  }

  return matches;
}

export function collectFootnoteReferences(content: string): FootnoteSelectionMatch[] {
  const lineStarts = buildLineStarts(content);
  const occurrenceByLabel = new Map<string, number>();
  const excludedRanges = collectExcludedFootnoteLiteralRanges(content);
  const matches: FootnoteSelectionMatch[] = [];

  for (const match of content.matchAll(FOOTNOTE_TOKEN_RE)) {
    const label = match[1] ?? "";
    const tokenStart = match.index ?? 0;
    const tokenEnd = tokenStart + match[0].length;

    if (
      isDefinitionToken(content, tokenStart, tokenEnd) ||
      isOffsetInsideAnyRange(tokenStart, excludedRanges)
    ) {
      continue;
    }

    const occurrence = (occurrenceByLabel.get(label) ?? 0) + 1;
    occurrenceByLabel.set(label, occurrence);

    matches.push({
      kind: "footnote_reference",
      label,
      occurrence,
      tokenStartOffsetUtf16: tokenStart,
      tokenEndOffsetUtf16: tokenEnd,
      blockStartOffsetUtf16: tokenStart,
      blockEndOffsetUtf16: tokenEnd,
      startLine: offsetToLineNumber(lineStarts, tokenStart),
      endLine: offsetToLineNumber(lineStarts, Math.max(tokenEnd - 1, tokenStart)),
    });
  }

  return matches;
}

function collectExcludedFootnoteLiteralRanges(content: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  ranges.push(...collectInlineCodeRanges(content));
  ranges.push(...collectFencedCodeRanges(content));
  return ranges;
}

function collectInlineCodeRanges(content: string) {
  const ranges: Array<{ from: number; to: number }> = [];

  for (const match of content.matchAll(/`[^`\n]+`/g)) {
    const from = match.index ?? 0;
    ranges.push({
      from,
      to: from + match[0].length,
    });
  }

  return ranges;
}

function collectFencedCodeRanges(content: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  const lines = content.split("\n");
  let offset = 0;
  let openFence: { marker: string; start: number } | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1];

      if (!openFence) {
        openFence = {
          marker,
          start: offset,
        };
      } else if (marker[0] === openFence.marker[0] && marker.length >= openFence.marker.length) {
        ranges.push({
          from: openFence.start,
          to: offset + line.length,
        });
        openFence = null;
      }
    }

    offset += line.length + 1;
  }

  return ranges;
}

function isOffsetInsideAnyRange(offset: number, ranges: Array<{ from: number; to: number }>) {
  return ranges.some((range) => offset >= range.from && offset < range.to);
}

function findDefinitionBlockEnd(content: string, definitionStart: number) {
  let lineStart = definitionStart;

  while (lineStart < content.length) {
    const lineEnd = findLineEnd(content, lineStart);
    const nextLineStart = advanceToNextLine(content, lineEnd);

    if (nextLineStart >= content.length) {
      return lineEnd;
    }

    const nextLineEnd = findLineEnd(content, nextLineStart);
    const nextLine = content.slice(nextLineStart, nextLineEnd);

    if (nextLine.trim() === "") {
      lineStart = nextLineStart;
      continue;
    }

    if (/^(?: {4,}|\t)/.test(nextLine)) {
      lineStart = nextLineStart;
      continue;
    }

    return lineEnd;
  }

  return content.length;
}

function isDefinitionToken(content: string, tokenStart: number, tokenEnd: number) {
  if (content[tokenEnd] !== ":") {
    return false;
  }

  const lineStart = content.lastIndexOf("\n", tokenStart - 1) + 1;
  const prefix = content.slice(lineStart, tokenStart);
  return /^ {0,3}$/.test(prefix);
}

function rangesOverlap(
  selectionStart: number,
  selectionEnd: number,
  match: Pick<FootnoteSelectionMatch, "blockStartOffsetUtf16" | "blockEndOffsetUtf16">,
) {
  return (
    selectionStart < match.blockEndOffsetUtf16 && selectionEnd > match.blockStartOffsetUtf16
  );
}

function buildLineStarts(content: string) {
  const starts = [0];

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      starts.push(index + 1);
    }
  }

  return starts;
}

function offsetToLineNumber(lineStarts: number[], offset: number) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const middleStart = lineStarts[middle];
    const nextStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < middleStart) {
      high = middle - 1;
      continue;
    }

    if (offset >= nextStart) {
      low = middle + 1;
      continue;
    }

    return middle + 1;
  }

  return lineStarts.length;
}

function findLineEnd(content: string, lineStart: number) {
  const newlineIndex = content.indexOf("\n", lineStart);
  return newlineIndex === -1 ? content.length : newlineIndex;
}

function advanceToNextLine(content: string, lineEnd: number) {
  return lineEnd >= content.length ? content.length : lineEnd + 1;
}
