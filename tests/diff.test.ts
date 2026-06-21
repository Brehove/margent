import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, type ParsedDiffDocument } from "../src/lib/diff";

interface DiffCase {
  assert: (parsed: ParsedDiffDocument) => void;
  diff: string;
  name: string;
}

const cases: DiffCase[] = [
  {
    name: "added-only hunks count additions and preserve line numbers",
    diff: [
      "--- original",
      "+++ revised",
      "@@ -1 +1,2 @@",
      " unchanged",
      "+added",
    ].join("\n"),
    assert(parsed) {
      expect(parsed.additions).toBe(1);
      expect(parsed.removals).toBe(0);
      expect(parsed.beforeLabel).toBe("Original");
      expect(parsed.afterLabel).toBe("Revised");
      expect(parsed.hunks).toHaveLength(1);
      expect(parsed.hunks[0].header).toBe("Before line 1 -> After lines 1-2");
      expect(parsed.hunks[0].additions).toBe(1);
      expect(parsed.hunks[0].removals).toBe(0);
      expect(parsed.hunks[0].lines).toEqual([
        {
          kind: "context",
          newLineNumber: 1,
          oldLineNumber: 1,
          text: "unchanged",
        },
        {
          kind: "added",
          newLineNumber: 2,
          oldLineNumber: null,
          text: "added",
        },
      ]);
    },
  },
  {
    name: "removed-only hunks count removals and preserve line numbers",
    diff: [
      "--- original",
      "+++ revised",
      "@@ -1,2 +1 @@",
      " unchanged",
      "-removed",
    ].join("\n"),
    assert(parsed) {
      expect(parsed.additions).toBe(0);
      expect(parsed.removals).toBe(1);
      expect(parsed.hunks).toHaveLength(1);
      expect(parsed.hunks[0].header).toBe("Before lines 1-2 -> After line 1");
      expect(parsed.hunks[0].additions).toBe(0);
      expect(parsed.hunks[0].removals).toBe(1);
      expect(parsed.hunks[0].lines).toEqual([
        {
          kind: "context",
          newLineNumber: 1,
          oldLineNumber: 1,
          text: "unchanged",
        },
        {
          kind: "removed",
          newLineNumber: null,
          oldLineNumber: 2,
          text: "removed",
        },
      ]);
    },
  },
  {
    name: "mixed replacements keep old and new line numbers distinct",
    diff: [
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,3 +1,3 @@",
      " keep before",
      "-old sentence",
      "+new sentence",
      " keep after",
    ].join("\n"),
    assert(parsed) {
      expect(parsed.additions).toBe(1);
      expect(parsed.removals).toBe(1);
      expect(parsed.beforeLabel).toBe("doc.md");
      expect(parsed.afterLabel).toBe("doc.md");
      expect(parsed.hunks[0].header).toBe("Before lines 1-3 -> After lines 1-3");
      expect(parsed.hunks[0].lines).toEqual([
        {
          kind: "context",
          newLineNumber: 1,
          oldLineNumber: 1,
          text: "keep before",
        },
        {
          kind: "removed",
          newLineNumber: null,
          oldLineNumber: 2,
          text: "old sentence",
        },
        {
          kind: "added",
          newLineNumber: 2,
          oldLineNumber: null,
          text: "new sentence",
        },
        {
          kind: "context",
          newLineNumber: 3,
          oldLineNumber: 3,
          text: "keep after",
        },
      ]);
    },
  },
  {
    name: "multiple hunks accumulate document totals independently",
    diff: [
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      "@@ -10,2 +10,3 @@ section",
      " keep",
      "+extra",
      " tail",
    ].join("\n"),
    assert(parsed) {
      expect(parsed.additions).toBe(2);
      expect(parsed.removals).toBe(1);
      expect(parsed.hunks).toHaveLength(2);
      expect(parsed.hunks[0]).toMatchObject({
        additions: 1,
        header: "Before line 1 -> After line 1",
        rawHeader: "@@ -1 +1 @@",
        removals: 1,
      });
      expect(parsed.hunks[1]).toMatchObject({
        additions: 1,
        header: "Before lines 10-11 -> After lines 10-12",
        rawHeader: "@@ -10,2 +10,3 @@ section",
        removals: 0,
      });
      expect(parsed.hunks[1].lines).toEqual([
        {
          kind: "context",
          newLineNumber: 10,
          oldLineNumber: 10,
          text: "keep",
        },
        {
          kind: "added",
          newLineNumber: 11,
          oldLineNumber: null,
          text: "extra",
        },
        {
          kind: "context",
          newLineNumber: 12,
          oldLineNumber: 11,
          text: "tail",
        },
      ]);
    },
  },
  {
    name: "dev null new file labels are normalized",
    diff: [
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+there",
    ].join("\n"),
    assert(parsed) {
      expect(parsed.beforeLabel).toBe("No file");
      expect(parsed.afterLabel).toBe("new.md");
      expect(parsed.additions).toBe(2);
      expect(parsed.removals).toBe(0);
      expect(parsed.hunks[0].header).toBe("Before new file -> After lines 1-2");
      expect(parsed.hunks[0].lines).toEqual([
        {
          kind: "added",
          newLineNumber: 1,
          oldLineNumber: null,
          text: "hello",
        },
        {
          kind: "added",
          newLineNumber: 2,
          oldLineNumber: null,
          text: "there",
        },
      ]);
    },
  },
  {
    name: "CRLF input is normalized before parsing",
    diff: [
      "--- a/windows.md",
      "+++ b/windows.md",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+gamma",
    ].join("\r\n"),
    assert(parsed) {
      expect(parsed.beforeLabel).toBe("windows.md");
      expect(parsed.afterLabel).toBe("windows.md");
      expect(parsed.additions).toBe(1);
      expect(parsed.removals).toBe(1);
      expect(parsed.hunks[0].lines).toEqual([
        {
          kind: "context",
          newLineNumber: 1,
          oldLineNumber: 1,
          text: "alpha",
        },
        {
          kind: "removed",
          newLineNumber: null,
          oldLineNumber: 2,
          text: "beta",
        },
        {
          kind: "added",
          newLineNumber: 2,
          oldLineNumber: null,
          text: "gamma",
        },
      ]);
    },
  },
  {
    name: "no-newline meta lines do not affect counts or line numbers",
    diff: [
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n"),
    assert(parsed) {
      expect(parsed.additions).toBe(1);
      expect(parsed.removals).toBe(1);
      expect(parsed.hunks[0].lines).toEqual([
        {
          kind: "removed",
          newLineNumber: null,
          oldLineNumber: 1,
          text: "old",
        },
        {
          kind: "meta",
          newLineNumber: null,
          oldLineNumber: null,
          text: "\\ No newline at end of file",
        },
        {
          kind: "added",
          newLineNumber: 1,
          oldLineNumber: null,
          text: "new",
        },
        {
          kind: "meta",
          newLineNumber: null,
          oldLineNumber: null,
          text: "\\ No newline at end of file",
        },
      ]);
    },
  },
];

describe("parseUnifiedDiff", () => {
  it.each(cases)("$name", ({ assert, diff }) => {
    assert(parseUnifiedDiff(diff));
  });
});
