import type { AnchorRecord, ThreadRecord } from "../src/types/thread";

const CONTEXT_RADIUS = 48;

interface ThreadSpec {
  end: number;
  id: string;
  kind?: AnchorRecord["kind"];
  footnote?: AnchorRecord["footnote"];
  quote: string;
  start: number;
}

export interface PerfScenario {
  content: string;
  threads: ThreadRecord[];
}

export function createLargePlainDocument(paragraphCount = 400) {
  return Array.from({ length: paragraphCount }, (_, index) =>
    `Paragraph ${String(index + 1).padStart(4, "0")} keeps the document large enough to exercise editor string extraction without any thread decoration overhead in the measurement path.`,
  ).join("\n\n");
}

export function createManyThreadScenario(threadCount = 180): PerfScenario {
  const lines: string[] = [];
  const specs: ThreadSpec[] = [];
  let offset = 0;

  for (let index = 0; index < threadCount; index += 1) {
    const paragraph = `Paragraph ${String(index + 1).padStart(4, "0")} contains tracked sentence ${String(index + 1).padStart(4, "0")} for marker rebuild performance and live anchor mapping checks.`;
    const tracked = `tracked sentence ${String(index + 1).padStart(4, "0")}`;
    const localStart = paragraph.indexOf(tracked);

    lines.push(paragraph);
    specs.push({
      end: offset + localStart + tracked.length,
      id: `thread_many_${index + 1}`,
      quote: tracked,
      start: offset + localStart,
    });

    offset += paragraph.length + 2;
  }

  const content = lines.join("\n\n");
  return {
    content,
    threads: specs.map((spec) => makeThread(content, spec)),
  };
}

export function createFootnoteHeavyScenario(noteCount = 120): PerfScenario {
  const lines: string[] = ["# Footnote Perf", ""];
  const specs: ThreadSpec[] = [];
  let offset = lines.join("\n").length + 1;

  for (let index = 0; index < noteCount; index += 1) {
    const label = `n${index + 1}`;
    const referenceToken = `[^${label}]`;
    const paragraph = `Footnote paragraph ${String(index + 1).padStart(3, "0")} references note${referenceToken} and keeps enough body text around the reference for context-based resolution checks.`;
    const localStart = paragraph.indexOf(referenceToken);

    lines.push(paragraph, "");
    specs.push({
      end: offset + localStart + referenceToken.length,
      footnote: { label, occurrence: 1 },
      id: `thread_footnote_ref_${index + 1}`,
      kind: "footnote_reference",
      quote: referenceToken,
      start: offset + localStart,
    });

    offset += paragraph.length + 2;
  }

  lines.push("");
  offset += 1;

  for (let index = 0; index < noteCount; index += 1) {
    const label = `n${index + 1}`;
    const definition = `[^${label}]: Footnote body ${String(index + 1).padStart(3, "0")} keeps semantic anchor reattachment deterministic for this benchmark corpus.`;
    const quote = `Footnote body ${String(index + 1).padStart(3, "0")}`;
    const localStart = definition.indexOf(quote);

    lines.push(definition);
    specs.push({
      end: offset + localStart + quote.length,
      footnote: { label, occurrence: 1 },
      id: `thread_footnote_def_${index + 1}`,
      kind: "footnote_definition",
      quote,
      start: offset + localStart,
    });

    offset += definition.length + 1;
  }

  const content = lines.join("\n");
  return {
    content,
    threads: specs.map((spec) => makeThread(content, spec)),
  };
}

function makeThread(content: string, spec: ThreadSpec): ThreadRecord {
  return {
    schemaVersion: 5,
    id: spec.id,
    documentId: "doc_perf",
    status: "open",
    createdAt: "2026-03-20T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
    createdBy: "codex",
    title: spec.id,
    tags: [],
    anchor: makeAnchor(content, spec),
    messages: [],
    linkedProposalIds: [],
    providerSessions: {},
  };
}

function makeAnchor(content: string, spec: ThreadSpec): AnchorRecord {
  const startLine = content.slice(0, spec.start).split("\n").length;
  const startColumn = spec.start - content.lastIndexOf("\n", spec.start - 1);
  const endLine = content.slice(0, spec.end).split("\n").length;
  const endColumn = spec.end - content.lastIndexOf("\n", spec.end - 1);

  return {
    quote: spec.quote,
    prefixContext: content.slice(Math.max(0, spec.start - CONTEXT_RADIUS), spec.start),
    suffixContext: content.slice(spec.end, spec.end + CONTEXT_RADIUS),
    startOffsetUtf16: spec.start,
    endOffsetUtf16: spec.end,
    startLine,
    startColumn,
    endLine,
    endColumn,
    headingPath: [],
    blockFingerprint: `block:${spec.quote}`,
    baseContentHash: "sha256:perf",
    kind: spec.kind ?? "text_span",
    footnote: spec.footnote ?? null,
    state: "attached",
    confidence: 1,
  };
}
