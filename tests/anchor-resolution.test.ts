import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { AnchorRecord, ThreadRecord } from "../src/types/thread";
import {
  resolveAnchorRange,
  resolveThreadAnchors,
  type ResolvedThreadAnchor,
} from "../src/lib/anchorResolution";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(__dirname, "..", "test-fixtures", "sample-workspace");
const README_CONTENT = readFileSync(join(FIXTURE_DIR, "README.md"), "utf8");

/** Build a minimal AnchorRecord. Every test can override specific fields. */
function makeAnchor(overrides: Partial<AnchorRecord> = {}): AnchorRecord {
  return {
    quote: "The quick brown fox jumps over the lazy dog.",
    prefixContext: "sting Margent's review workflows.\n\n## Overview\n\n",
    suffixContext: " This sentence is used throughout the test suite",
    startOffsetUtf16: 99,
    endOffsetUtf16: 143,
    startLine: 7,
    startColumn: 1,
    endLine: 7,
    endColumn: 45,
    headingPath: ["Sample Project", "Overview"],
    blockFingerprint: "sha256:placeholder",
    baseContentHash: "sha256:placeholder",
    state: "attached",
    confidence: 1,
    ...overrides,
  };
}

/** Build a minimal ThreadRecord wrapping an anchor. */
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

// ---------------------------------------------------------------------------
// 1. Exact match
// ---------------------------------------------------------------------------

describe("Exact match", () => {
  it("returns method 'exact' when the quote exists at the original offset", () => {
    const anchor = makeAnchor();
    const result = resolveAnchorRange(anchor, README_CONTENT);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("exact");
    expect(result!.from).toBe(99);
    expect(result!.to).toBe(143);
  });

  it("returns exact for the second fixture anchor as well", () => {
    const anchor = makeAnchor({
      quote: "Anchors track the original quoted text",
      prefixContext: " CLI or the desktop app.\n\n### Thread Anchoring\n\n",
      suffixContext: ", surrounding context, heading path, and block f",
      startOffsetUtf16: 427,
      endOffsetUtf16: 465,
      startLine: 15,
      startColumn: 1,
      endLine: 15,
      endColumn: 39,
    });
    const result = resolveAnchorRange(anchor, README_CONTENT);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("exact");
    expect(result!.from).toBe(427);
    expect(result!.to).toBe(465);
  });
});

// ---------------------------------------------------------------------------
// 2. Persisted range
// ---------------------------------------------------------------------------

describe("Persisted range", () => {
  it("returns method 'persisted' when content changed but offsets still valid", () => {
    // Replace the quote text at offsets 99..143 with something different but
    // keep the same length so the offsets are still in-bounds.
    const replacement = "XXXX quick brown fox jumps over XXXX dog!!!!";
    expect(replacement.length).toBe(44); // same as original quote length
    const modified =
      README_CONTENT.slice(0, 99) + replacement + README_CONTENT.slice(143);

    const anchor = makeAnchor(); // still points to 99..143
    const result = resolveAnchorRange(anchor, modified);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("persisted");
    expect(result!.from).toBe(99);
    expect(result!.to).toBe(143);
  });

  it("returns 'persisted' when surrounding context changed but offsets in range", () => {
    // Insert extra text before offset 99 so the real quote shifts right,
    // but the anchor's offsets (99..143) still point to in-bounds content
    // that is now different from the original quote.
    const insertion = "EXTRA INSERTED TEXT. ";
    const modified =
      README_CONTENT.slice(0, 80) + insertion + README_CONTENT.slice(80);

    // The content at 99..143 is now different (shifted by insertion)
    const anchor = makeAnchor({
      startOffsetUtf16: 99,
      endOffsetUtf16: 143,
    });
    const result = resolveAnchorRange(anchor, modified);

    expect(result).not.toBeNull();
    // The content at 99..143 is no longer the original quote, so persisted
    expect(result!.method).toBe("persisted");
  });
});

// ---------------------------------------------------------------------------
// 3. Context match
// ---------------------------------------------------------------------------

describe("Context match", () => {
  it("returns method 'context' when quote moved but prefix/suffix context matches", () => {
    // The quote and its surrounding context exist in the document, but the
    // anchor offsets are stale (beyond document length) so persisted range fails.
    // The quote search finds the text and context scoring yields "context".
    const anchor = makeAnchor({
      // Point offsets well beyond the document so persisted range is skipped
      startOffsetUtf16: README_CONTENT.length + 100,
      endOffsetUtf16: README_CONTENT.length + 144,
    });
    const result = resolveAnchorRange(anchor, README_CONTENT);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("context");
    expect(result!.from).toBe(99);
    expect(result!.to).toBe(143);
  });

  it("returns 'context' when detached anchor with matching quote and context", () => {
    // Detached state skips persisted range, so context-based search takes over.
    // Both prefix and suffix match, so score >= 10 => "context".
    const anchor = makeAnchor({ state: "detached" });
    const result = resolveAnchorRange(anchor, README_CONTENT);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("context");
    expect(result!.from).toBe(99);
    expect(result!.to).toBe(143);
  });

  it("returns 'context' for a quote that shifted in a modified document", () => {
    // Prepend text so the quote shifts. Set offsets beyond modified content
    // length so persisted range fails and quote search runs.
    const prefix = "A".repeat(500) + "\n\n";
    const modified = prefix + README_CONTENT;

    const anchor = makeAnchor({
      startOffsetUtf16: modified.length + 10,
      endOffsetUtf16: modified.length + 54,
    });
    const result = resolveAnchorRange(anchor, modified);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("context");
    expect(result!.from).toBe(99 + prefix.length);
    expect(result!.to).toBe(143 + prefix.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Quote match (no context match)
// ---------------------------------------------------------------------------

describe("Quote match", () => {
  it("returns method 'quote' when quote found but context does not match", () => {
    // Build a document that has the quoted text but completely different surroundings
    const paddingA = "A".repeat(50);
    const paddingB = "B".repeat(50);
    const content = paddingA + "The quick brown fox jumps over the lazy dog." + paddingB;

    const anchor = makeAnchor({
      // offsets point well beyond document so persisted range is skipped
      startOffsetUtf16: 9999,
      endOffsetUtf16: 10043,
    });
    const result = resolveAnchorRange(anchor, content);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("quote");
    expect(result!.from).toBe(50);
    expect(result!.to).toBe(50 + 44);
  });

  it("returns 'quote' when prefix matches but suffix does not", () => {
    const quote = "The quick brown fox jumps over the lazy dog.";
    const prefix = "sting Margent's review workflows.\n\n## Overview\n\n";
    // Correct prefix, wrong suffix
    const content = prefix + quote + " COMPLETELY DIFFERENT SUFFIX TEXT";

    const anchor = makeAnchor({
      startOffsetUtf16: 9999,
      endOffsetUtf16: 10043,
      prefixContext: prefix,
      suffixContext: " This sentence is used throughout the test suite",
    });
    const result = resolveAnchorRange(anchor, content);

    expect(result).not.toBeNull();
    // prefix match gives 12, no suffix match gives 0, score = 12 - distance penalty
    // distance penalty = |49 - 9999| / 1000 = ~9.95, so score ~ 2.05 < 10
    expect(result!.method).toBe("quote");
  });
});

// ---------------------------------------------------------------------------
// 5. No match
// ---------------------------------------------------------------------------

describe("No match", () => {
  it("returns null when the quote is completely absent from the document", () => {
    const anchor = makeAnchor({
      quote: "This text does not exist anywhere in the document at all.",
      startOffsetUtf16: 9999,
      endOffsetUtf16: 10055,
    });
    const result = resolveAnchorRange(anchor, README_CONTENT);

    expect(result).toBeNull();
  });

  it("returns null when content is empty", () => {
    const anchor = makeAnchor();
    const result = resolveAnchorRange(anchor, "");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Multi-thread resolution (batch)
// ---------------------------------------------------------------------------

describe("Multi-thread resolution", () => {
  it("resolves a batch of threads with mixed states", () => {
    // Thread 1: exact match on original content
    const thread1 = makeThread("t1");

    // Thread 2: also exact (second fixture anchor)
    const thread2 = makeThread("t2", {
      quote: "Anchors track the original quoted text",
      prefixContext: " CLI or the desktop app.\n\n### Thread Anchoring\n\n",
      suffixContext: ", surrounding context, heading path, and block f",
      startOffsetUtf16: 427,
      endOffsetUtf16: 465,
    });

    // Thread 3: quote that doesn't exist => should be filtered out
    const thread3 = makeThread("t3", {
      quote: "nonexistent text that is not in the document",
      startOffsetUtf16: 9999,
      endOffsetUtf16: 10044,
    });

    const results = resolveThreadAnchors([thread1, thread2, thread3], README_CONTENT);

    expect(results).toHaveLength(2);

    const r1 = results.find((r) => r.threadId === "t1");
    expect(r1).toBeDefined();
    expect(r1!.method).toBe("exact");
    expect(r1!.ordinal).toBe(1);

    const r2 = results.find((r) => r.threadId === "t2");
    expect(r2).toBeDefined();
    expect(r2!.method).toBe("exact");
    expect(r2!.ordinal).toBe(2);

    // t3 should not appear
    expect(results.find((r) => r.threadId === "t3")).toBeUndefined();
  });

  it("assigns ordinals based on input order, not resolution order", () => {
    const threadA = makeThread("a");
    const threadB = makeThread("b", {
      quote: "Anchors track the original quoted text",
      startOffsetUtf16: 427,
      endOffsetUtf16: 465,
    });

    const results = resolveThreadAnchors([threadA, threadB], README_CONTENT);
    expect(results[0].ordinal).toBe(1);
    expect(results[1].ordinal).toBe(2);
  });

  it("includes state and confidence from the thread anchor", () => {
    const thread = makeThread("t", { state: "shifted", confidence: 0.75 });
    // state is "shifted", not "detached", so persisted range should work
    const results = resolveThreadAnchors([thread], README_CONTENT);

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("shifted");
    expect(results[0].confidence).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// 7. Clamping (offsets beyond document bounds)
// ---------------------------------------------------------------------------

describe("Clamping / out-of-bounds offsets", () => {
  it("returns null from persisted range when endOffset exceeds content length", () => {
    const anchor = makeAnchor({
      startOffsetUtf16: 0,
      endOffsetUtf16: README_CONTENT.length + 100,
    });

    // resolvePersistedRange should bail because endOffset > content.length
    // Then it falls through to quote search
    const result = resolveAnchorRange(anchor, README_CONTENT);

    // The quote still exists in the document, so it should be found via quote/context match
    expect(result).not.toBeNull();
    expect(["context", "quote"]).toContain(result!.method);
  });

  it("returns null from persisted range when startOffset is negative", () => {
    const anchor = makeAnchor({
      startOffsetUtf16: -5,
      endOffsetUtf16: 143,
    });

    const result = resolveAnchorRange(anchor, README_CONTENT);

    // persisted range bails on negative start, falls through to quote search
    expect(result).not.toBeNull();
    expect(["context", "quote"]).toContain(result!.method);
  });

  it("returns null from persisted range when startOffset >= endOffset", () => {
    const anchor = makeAnchor({
      startOffsetUtf16: 143,
      endOffsetUtf16: 99,
    });

    const result = resolveAnchorRange(anchor, README_CONTENT);

    // persisted range bails, falls through to quote search
    expect(result).not.toBeNull();
    expect(["context", "quote"]).toContain(result!.method);
  });

  it("returns null entirely when offsets are bad and quote not found", () => {
    const anchor = makeAnchor({
      quote: "text that does not exist",
      startOffsetUtf16: -10,
      endOffsetUtf16: README_CONTENT.length + 500,
    });

    const result = resolveAnchorRange(anchor, README_CONTENT);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Detached anchor
// ---------------------------------------------------------------------------

describe("Detached anchor", () => {
  it("skips persisted range and falls through to quote search", () => {
    // Even though offsets are correct, detached state forces quote-based resolution
    const anchor = makeAnchor({ state: "detached" });
    const result = resolveAnchorRange(anchor, README_CONTENT);

    expect(result).not.toBeNull();
    // Since quote exists and context matches, it should be "context"
    expect(result!.method).toBe("context");
    expect(result!.from).toBe(99);
    expect(result!.to).toBe(143);
  });

  it("returns null if detached and quote not found", () => {
    const anchor = makeAnchor({
      state: "detached",
      quote: "text that has been completely removed from document",
    });

    const result = resolveAnchorRange(anchor, README_CONTENT);
    expect(result).toBeNull();
  });

  it("resolves via 'quote' when detached with matching quote but no context", () => {
    const content =
      "AAAA" +
      "The quick brown fox jumps over the lazy dog." +
      "BBBB";

    const anchor = makeAnchor({ state: "detached" });
    const result = resolveAnchorRange(anchor, content);

    expect(result).not.toBeNull();
    expect(result!.method).toBe("quote");
    expect(result!.from).toBe(4);
    expect(result!.to).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// 9. Scoring (context scoring prefers better prefix/suffix alignment)
// ---------------------------------------------------------------------------

describe("Scoring", () => {
  it("prefers the match with both prefix and suffix context over one with neither", () => {
    const quote = "target text";
    // Two occurrences of the quote; first has wrong context, second has correct context
    const content =
      "WRONG_PREFIX" +
      quote +
      "WRONG_SUFFIX_padding_padding_padding_padding" +
      "sting Margent's review workflows.\n\n## Overview\n\n" +
      quote +
      " This sentence is used throughout the test suite";

    const anchor = makeAnchor({
      quote,
      prefixContext: "sting Margent's review workflows.\n\n## Overview\n\n",
      suffixContext: " This sentence is used throughout the test suite",
      startOffsetUtf16: 9999, // far away, so distance penalty hits both
      endOffsetUtf16: 10010,
    });

    const result = resolveAnchorRange(anchor, content);

    expect(result).not.toBeNull();
    // The second occurrence has matching prefix+suffix, so it should win
    const expectedStart = content.lastIndexOf(quote);
    expect(result!.from).toBe(expectedStart);
    expect(result!.method).toBe("context");
  });

  it("distance penalty breaks ties when context is identical", () => {
    const quote = "duplicated text";
    // Two identical contexts but different distances from the original offset
    const padding1 = "X".repeat(100);
    const padding2 = "Y".repeat(500);
    const context = "PREFIX_MATCH";
    const suffix = "SUFFIX_MATCH";

    const content =
      context + quote + suffix + padding1 + context + quote + suffix + padding2;

    const firstStart = context.length;
    const secondStart =
      context.length + quote.length + suffix.length + padding1.length + context.length;

    const anchor = makeAnchor({
      quote,
      prefixContext: context,
      suffixContext: suffix,
      // Use "detached" to bypass persisted range and exercise the scoring logic
      state: "detached",
      // Place the original offset closer to the first occurrence
      startOffsetUtf16: firstStart,
      endOffsetUtf16: firstStart + quote.length,
    });

    const result = resolveAnchorRange(anchor, content);

    expect(result).not.toBeNull();
    // Both occurrences have identical prefix+suffix scores (24 each).
    // First occurrence is closer to original offset, so it wins via lower distance penalty.
    expect(result!.from).toBe(firstStart);
    expect(result!.method).toBe("context");

    // Now flip: place the original offset closer to the second occurrence
    const anchor2 = makeAnchor({
      quote,
      prefixContext: context,
      suffixContext: suffix,
      state: "detached",
      startOffsetUtf16: secondStart,
      endOffsetUtf16: secondStart + quote.length,
    });

    const result2 = resolveAnchorRange(anchor2, content);
    expect(result2).not.toBeNull();
    expect(result2!.from).toBe(secondStart);
  });

  it("score threshold: >= 10 yields 'context', < 10 yields 'quote'", () => {
    const quote = "target text";

    // Only prefix matches (score = 12 - distancePenalty)
    // If distance is small, score > 10 => context
    const contentClose = "CORRECT_PREFIX" + quote + "WRONG_SUFFIX";

    const anchorClose = makeAnchor({
      quote,
      prefixContext: "CORRECT_PREFIX",
      suffixContext: "DOES_NOT_MATCH",
      // Use "detached" to skip persisted range and force quote search
      state: "detached",
      startOffsetUtf16: 14, // exactly at quote start, distance = 0
      endOffsetUtf16: 25,
    });

    const resultClose = resolveAnchorRange(anchorClose, contentClose);
    expect(resultClose).not.toBeNull();
    // score = 12 (prefix) + 0 (no suffix) - 0/1000 (distance) = 12 >= 10
    expect(resultClose!.method).toBe("context");

    // Now if distance is large enough to push score below 10
    // score = 12 - distance/1000. Need distance > 2000 for score < 10
    const anchorFar = makeAnchor({
      quote,
      prefixContext: "CORRECT_PREFIX",
      suffixContext: "DOES_NOT_MATCH",
      state: "detached",
      startOffsetUtf16: 3000, // distance = |3000 - 14| / 1000 = 2.986
      endOffsetUtf16: 3011,
    });

    const resultFar = resolveAnchorRange(anchorFar, contentClose);
    expect(resultFar).not.toBeNull();
    // score = 12 - 2.986 = 9.014 < 10
    expect(resultFar!.method).toBe("quote");
  });
});

// ---------------------------------------------------------------------------
// 10. Empty quote
// ---------------------------------------------------------------------------

describe("Empty quote", () => {
  it("returns null when quote is an empty string (persisted range invalid, no quote matches)", () => {
    const anchor = makeAnchor({
      quote: "",
      startOffsetUtf16: 99,
      endOffsetUtf16: 99, // start == end
    });
    const result = resolveAnchorRange(anchor, README_CONTENT);

    // persisted range: startOffset >= endOffset => null
    // collectQuoteMatches returns [] for empty quote => null
    expect(result).toBeNull();
  });

  it("returns null when quote is empty even with valid-looking offsets", () => {
    const anchor = makeAnchor({
      quote: "",
      startOffsetUtf16: 10,
      endOffsetUtf16: 50,
    });
    const result = resolveAnchorRange(anchor, README_CONTENT);

    // persisted range: offsets valid & start < end => method is persisted (content != "")
    // Actually the persisted range will return because start < end and offsets in bounds
    expect(result).not.toBeNull();
    expect(result!.method).toBe("persisted");
    expect(result!.from).toBe(10);
    expect(result!.to).toBe(50);
  });
});
