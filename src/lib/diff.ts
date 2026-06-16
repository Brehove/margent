export type DiffLineKind = "context" | "added" | "removed" | "meta";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  newLineNumber: number | null;
  oldLineNumber: number | null;
  text: string;
}

export interface ParsedDiffHunk {
  additions: number;
  header: string;
  lines: ParsedDiffLine[];
  rawHeader: string;
  removals: number;
}

export interface ParsedDiffDocument {
  additions: number;
  afterLabel: string;
  beforeLabel: string;
  hunks: ParsedDiffHunk[];
  removals: number;
}

interface HunkRange {
  count: number;
  start: number;
}

export function parseUnifiedDiff(diffText: string): ParsedDiffDocument {
  const hunks: ParsedDiffHunk[] = [];
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  let additions = 0;
  let beforeLabel = "Original";
  let afterLabel = "Revised";
  let currentHunk: ParsedDiffHunk | null = null;
  let currentOldLine = 0;
  let currentNewLine = 0;
  let removals = 0;

  for (const rawLine of lines) {
    if (rawLine.startsWith("--- ")) {
      beforeLabel = normalizeDiffLabel(rawLine.slice(4));
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      afterLabel = normalizeDiffLabel(rawLine.slice(4));
      continue;
    }

    if (rawLine.startsWith("@@")) {
      const range = parseHunkRange(rawLine);

      currentHunk = {
        additions: 0,
        header: formatHunkHeader(range),
        lines: [],
        rawHeader: rawLine,
        removals: 0,
      };
      hunks.push(currentHunk);
      currentOldLine = range.old.start;
      currentNewLine = range.newRange.start;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (rawLine.startsWith("+")) {
      currentHunk.additions += 1;
      additions += 1;
      currentHunk.lines.push({
        kind: "added",
        newLineNumber: currentNewLine,
        oldLineNumber: null,
        text: rawLine.slice(1),
      });
      currentNewLine += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      currentHunk.removals += 1;
      removals += 1;
      currentHunk.lines.push({
        kind: "removed",
        newLineNumber: null,
        oldLineNumber: currentOldLine,
        text: rawLine.slice(1),
      });
      currentOldLine += 1;
      continue;
    }

    if (rawLine.startsWith("\\")) {
      currentHunk.lines.push({
        kind: "meta",
        newLineNumber: null,
        oldLineNumber: null,
        text: rawLine,
      });
      continue;
    }

    currentHunk.lines.push({
      kind: "context",
      newLineNumber: currentNewLine,
      oldLineNumber: currentOldLine,
      text: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
    });
    currentOldLine += 1;
    currentNewLine += 1;
  }

  return {
    additions,
    afterLabel,
    beforeLabel,
    hunks,
    removals,
  };
}

function formatHunkHeader(range: { newRange: HunkRange; old: HunkRange }) {
  return `${formatLineWindow("Before", range.old)} -> ${formatLineWindow("After", range.newRange)}`;
}

function formatLineWindow(label: string, range: HunkRange) {
  if (range.start <= 0 && range.count === 0) {
    return `${label} new file`;
  }

  if (range.count <= 1) {
    return `${label} line ${range.start}`;
  }

  return `${label} lines ${range.start}-${range.start + range.count - 1}`;
}

function normalizeDiffLabel(label: string) {
  const trimmed = label.trim();

  if (!trimmed) {
    return "Document";
  }

  if (trimmed === "original") {
    return "Original";
  }

  if (trimmed === "revised") {
    return "Revised";
  }

  if (trimmed === "/dev/null") {
    return "No file";
  }

  return trimmed.replace(/^[ab]\//, "");
}

function parseHunkRange(rawHeader: string) {
  const match =
    /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/.exec(
      rawHeader,
    );

  if (!match?.groups) {
    return {
      newRange: { count: 1, start: 1 },
      old: { count: 1, start: 1 },
    };
  }

  return {
    newRange: {
      count: Number(match.groups.newCount ?? "1"),
      start: Number(match.groups.newStart),
    },
    old: {
      count: Number(match.groups.oldCount ?? "1"),
      start: Number(match.groups.oldStart),
    },
  };
}
