import type { AnchorRecord, ThreadRecord } from "../types/thread";
import { measurePerf } from "./devPerf";

export interface ResolvedThreadAnchor {
  confidence: number;
  from: number;
  method: "exact" | "context" | "persisted" | "quote";
  ordinal: number;
  state: ThreadRecord["anchor"]["state"];
  threadId: string;
  to: number;
}

export function resolveThreadAnchors(threads: ThreadRecord[], content: string): ResolvedThreadAnchor[] {
  return measurePerf(
    "resolveThreadAnchors",
    () =>
      threads.flatMap((thread, index) => {
        const range = resolveAnchorRange(thread.anchor, content);

        if (!range) {
          return [];
        }

        return [
          {
            confidence: thread.anchor.confidence,
            ...range,
            ordinal: index + 1,
            state: thread.anchor.state,
            threadId: thread.id,
          },
        ];
      }),
    {
      contentLength: content.length,
      threadCount: threads.length,
    },
  );
}

export function resolveAnchorRange(anchor: AnchorRecord, content: string) {
  const persistedRange = resolvePersistedRange(anchor, content);
  if (persistedRange) {
    return persistedRange;
  }

  const contextualMatch = resolveQuoteMatch(anchor, content);
  if (contextualMatch) {
    return contextualMatch;
  }

  return null;
}

function resolvePersistedRange(anchor: AnchorRecord, content: string) {
  if (anchor.state === "detached") {
    return null;
  }

  if (anchor.startOffsetUtf16 < 0 || anchor.endOffsetUtf16 > content.length) {
    return null;
  }

  if (anchor.startOffsetUtf16 >= anchor.endOffsetUtf16) {
    return null;
  }

  return {
    from: anchor.startOffsetUtf16,
    method:
      content.slice(anchor.startOffsetUtf16, anchor.endOffsetUtf16) === anchor.quote
        ? ("exact" as const)
        : ("persisted" as const),
    to: anchor.endOffsetUtf16,
  };
}

function resolveQuoteMatch(anchor: AnchorRecord, content: string) {
  const matches = collectQuoteMatches(anchor.quote, content);
  if (!matches.length) {
    return null;
  }

  const ranked = matches
    .map((start) => ({
      score: scoreQuoteMatch(anchor, content, start),
      start,
    }))
    .sort((left, right) => right.score - left.score);

  const winner = ranked[0];
  if (!winner) {
    return null;
  }

  return {
    from: winner.start,
    method: winner.score >= 10 ? ("context" as const) : ("quote" as const),
    to: winner.start + anchor.quote.length,
  };
}

function collectQuoteMatches(quote: string, content: string) {
  if (!quote) {
    return [];
  }

  const matches: number[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const index = content.indexOf(quote, cursor);
    if (index === -1) {
      break;
    }

    matches.push(index);
    cursor = index + Math.max(quote.length, 1);
  }

  return matches;
}

function scoreQuoteMatch(anchor: AnchorRecord, content: string, start: number) {
  const prefixStart = Math.max(0, start - anchor.prefixContext.length);
  const suffixEnd = start + anchor.quote.length + anchor.suffixContext.length;
  const prefixMatches =
    !anchor.prefixContext ||
    content.slice(prefixStart, start).endsWith(anchor.prefixContext);
  const suffixMatches =
    !anchor.suffixContext ||
    content.slice(start + anchor.quote.length, suffixEnd).startsWith(anchor.suffixContext);
  const distancePenalty = Math.abs(start - anchor.startOffsetUtf16) / 1000;

  let score = 0;

  if (prefixMatches) {
    score += 12;
  }

  if (suffixMatches) {
    score += 12;
  }

  return score - distancePenalty;
}
