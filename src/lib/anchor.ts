import type { AnchorRecord, EditorSelectionSnapshot } from "../types/thread";
import type { DocumentPayload, HeadingIndexEntry } from "../types/workspace";
import { resolveFootnoteAnchorSemantic } from "./footnote";

const CONTEXT_RADIUS = 48;

export async function createAnchor(
  document: DocumentPayload,
  content: string,
  selection: EditorSelectionSnapshot,
): Promise<AnchorRecord> {
  const prefixStart = Math.max(0, selection.startOffsetUtf16 - CONTEXT_RADIUS);
  const suffixEnd = Math.min(content.length, selection.endOffsetUtf16 + CONTEXT_RADIUS);
  const blockText = findContainingBlock(content, selection);
  const footnoteSemantic = resolveFootnoteAnchorSemantic(content, selection);

  return {
    quote: selection.quote,
    prefixContext: content.slice(prefixStart, selection.startOffsetUtf16),
    suffixContext: content.slice(selection.endOffsetUtf16, suffixEnd),
    startOffsetUtf16: selection.startOffsetUtf16,
    endOffsetUtf16: selection.endOffsetUtf16,
    startLine: selection.startLine,
    startColumn: selection.startColumn,
    endLine: selection.endLine,
    endColumn: selection.endColumn,
    headingPath: resolveHeadingPath(document.headingIndex, selection.startLine),
    blockFingerprint: `sha256:${await sha256Hex(normalizeBlockText(blockText))}`,
    baseContentHash: `sha256:${await sha256Hex(content)}`,
    kind: footnoteSemantic?.kind ?? "text_span",
    footnote: footnoteSemantic?.footnote ?? null,
    state: "attached",
    confidence: 1,
  };
}

export function defaultThreadTitle(quote: string) {
  const normalized = quote.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "New thread";
  }

  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function resolveHeadingPath(headings: HeadingIndexEntry[], line: number) {
  const stack: HeadingIndexEntry[] = [];

  for (const heading of headings) {
    if (heading.line > line) {
      break;
    }

    while (stack.length && stack[stack.length - 1].depth >= heading.depth) {
      stack.pop();
    }

    stack.push(heading);
  }

  return stack.map((heading) => heading.text);
}

function findContainingBlock(content: string, selection: EditorSelectionSnapshot) {
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(selection.startLine - 1, 0);
  const endIndex = Math.max(selection.endLine - 1, startIndex);
  let blockStart = startIndex;
  let blockEnd = Math.min(endIndex, lines.length - 1);

  while (blockStart > 0 && lines[blockStart - 1].trim()) {
    blockStart -= 1;
  }

  while (blockEnd < lines.length - 1 && lines[blockEnd + 1].trim()) {
    blockEnd += 1;
  }

  return lines.slice(blockStart, blockEnd + 1).join("\n");
}

function normalizeBlockText(block: string) {
  return block.replace(/\s+/g, " ").trim().toLowerCase();
}
