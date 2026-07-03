import { syntaxTree } from "@codemirror/language";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

export type MarkdownInlineMarker = "*" | "**" | "~~" | "`";
export type MarkdownListType = "bullet" | "ordered" | "task";

export type MarkdownFormattingCommand =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inline-code"
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "bullet-list"
  | "ordered-list"
  | "task-list"
  | "blockquote"
  | "code-block"
  | "horizontal-rule"
  | "footnote"
  | "table";

export interface MarkdownFormattingContext {
  blockquote: boolean;
  bold: boolean;
  headingLevel: number | null;
  inCodeBlock: boolean;
  inFrontmatter: boolean;
  inTable: boolean;
  inlineCode: boolean;
  italic: boolean;
  listType: MarkdownListType | null;
  strikethrough: boolean;
}

export const emptyFormattingContext: MarkdownFormattingContext = {
  blockquote: false,
  bold: false,
  headingLevel: null,
  inCodeBlock: false,
  inFrontmatter: false,
  inTable: false,
  inlineCode: false,
  italic: false,
  listType: null,
  strikethrough: false,
};

const HEADING_PATTERN = /^(\s{0,3})(#{1,6})(?:[ \t]+|$)(.*)$/;
const BLOCKQUOTE_PATTERN = /^(\s{0,3})>\s?/;
const BULLET_LIST_PATTERN = /^(\s*)([-+*])\s+/;
const ORDERED_LIST_PATTERN = /^(\s*)(\d+)([.)])\s+/;
const TASK_LIST_PATTERN = /^(\s*)([-+*]|\d+[.)])\s+\[([ xX])\]\s+/;
const CODE_FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const FRONTMATTER_BOUNDARY_PATTERN = /^(---|\.\.\.)\s*$/;
const FOOTNOTE_REFERENCE_PATTERN = /\[\^(\d+)\]/g;
const TABLE_DIVIDER_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const TABLE_ROW_PATTERN = /\|/;

export function runMarkdownFormattingCommand(
  view: EditorView,
  command: MarkdownFormattingCommand,
) {
  switch (command) {
    case "bold":
      return toggleMarkdownInlineStyle(view, "**");
    case "italic":
      return toggleMarkdownInlineStyle(view, "*");
    case "strikethrough":
      return toggleMarkdownInlineStyle(view, "~~");
    case "inline-code":
      return toggleMarkdownInlineStyle(view, "`");
    case "paragraph":
      return setHeadingLevel(view, 0);
    case "heading-1":
      return setHeadingLevel(view, 1);
    case "heading-2":
      return setHeadingLevel(view, 2);
    case "heading-3":
      return setHeadingLevel(view, 3);
    case "heading-4":
      return setHeadingLevel(view, 4);
    case "heading-5":
      return setHeadingLevel(view, 5);
    case "heading-6":
      return setHeadingLevel(view, 6);
    case "bullet-list":
      return toggleList(view, "bullet");
    case "ordered-list":
      return toggleList(view, "ordered");
    case "task-list":
      return toggleList(view, "task");
    case "blockquote":
      return toggleBlockquote(view);
    case "code-block":
      return insertCodeBlock(view);
    case "horizontal-rule":
      return insertHorizontalRule(view);
    case "footnote":
      return insertFootnote(view);
    case "table":
      return insertMarkdownTable(view);
    default:
      return false;
  }
}

export function getFormattingContext(state: EditorState): MarkdownFormattingContext {
  const selection = state.selection.main;
  const line = state.doc.lineAt(selection.from);
  const tableRange = findMarkdownTableRangeAt(state, selection.from);
  const headingMatch = line.text.match(HEADING_PATTERN);
  const listType = readLineListType(line.text);

  return {
    blockquote: BLOCKQUOTE_PATTERN.test(line.text),
    bold: isInlineStyleActiveAtSelection(state, "**"),
    headingLevel: headingMatch ? headingMatch[2].length : null,
    inCodeBlock: isPositionInsideFencedCodeBlock(state, selection.from),
    inFrontmatter: isPositionInsideFrontmatter(state, selection.from),
    inTable: tableRange !== null,
    inlineCode: isInlineStyleActiveAtSelection(state, "`"),
    italic: isInlineStyleActiveAtSelection(state, "*"),
    listType,
    strikethrough: isInlineStyleActiveAtSelection(state, "~~"),
  };
}

export function areFormattingContextsEqual(
  left: MarkdownFormattingContext,
  right: MarkdownFormattingContext,
) {
  return (
    left.blockquote === right.blockquote &&
    left.bold === right.bold &&
    left.headingLevel === right.headingLevel &&
    left.inCodeBlock === right.inCodeBlock &&
    left.inFrontmatter === right.inFrontmatter &&
    left.inTable === right.inTable &&
    left.inlineCode === right.inlineCode &&
    left.italic === right.italic &&
    left.listType === right.listType &&
    left.strikethrough === right.strikethrough
  );
}

export function toggleMarkdownInlineStyle(view: EditorView, marker: MarkdownInlineMarker) {
  const context = getFormattingContext(view.state);
  if (context.inCodeBlock || context.inFrontmatter) {
    return true;
  }

  const markerToUse =
    marker === "`" && selectionContainsBacktick(view.state)
      ? "``"
      : marker;
  const selection = view.state.selection.main;
  const markerLength = markerToUse.length;

  if (selection.empty) {
    view.dispatch({
      changes: {
        from: selection.from,
        insert: `${markerToUse}${markerToUse}`,
      },
      selection: {
        anchor: selection.from + markerLength,
      },
    });
    return true;
  }

  const selectedText = view.state.doc.sliceString(selection.from, selection.to);
  const selectedTextReplacement = toggleSelectedTextInlineStyle(selectedText, markerToUse);
  if (selectedTextReplacement !== null) {
    view.dispatch({
      changes: {
        from: selection.from,
        insert: selectedTextReplacement,
        to: selection.to,
      },
      selection: {
        anchor: selection.from,
        head: selection.from + selectedTextReplacement.length,
      },
    });
    return true;
  }

  const beforeRunLength = countRepeatedStringBefore(view.state, selection.from, markerToUse);
  const afterRunLength = countRepeatedStringAfter(view.state, selection.to, markerToUse);

  if (beforeRunLength > 0 && afterRunLength > 0) {
    view.dispatch({
      changes: [
        {
          from: selection.to,
          to: selection.to + markerLength,
        },
        {
          from: selection.from - markerLength,
          to: selection.from,
        },
      ],
      selection: {
        anchor: selection.from - markerLength,
        head: selection.to - markerLength,
      },
    });
    return true;
  }

  view.dispatch({
    changes: [
      {
        from: selection.from,
        insert: markerToUse,
      },
      {
        from: selection.to,
        insert: markerToUse,
      },
    ],
    selection: {
      anchor: selection.from + markerLength,
      head: selection.to + markerLength,
    },
  });
  return true;
}

export function setHeadingLevel(view: EditorView, level: number) {
  const lines = selectedLines(view.state);
  const mainLine = view.state.doc.lineAt(view.state.selection.main.from);
  const mainMatch = mainLine.text.match(HEADING_PATTERN);
  const shouldToggleOff = level > 0 && mainMatch?.[2].length === level;
  const nextLevel = shouldToggleOff ? 0 : level;
  const changes: ChangeSpec[] = [];

  for (const line of lines) {
    if (shouldSkipLineTransform(view.state, line.number) || findMarkdownTableRangeAtLine(view.state, line.number)) {
      continue;
    }

    const nextText =
      nextLevel === 0
        ? line.text.replace(HEADING_PATTERN, "$1$3")
        : line.text.match(HEADING_PATTERN)
          ? line.text.replace(HEADING_PATTERN, `$1${"#".repeat(nextLevel)} $3`)
          : `${"#".repeat(nextLevel)} ${line.text}`;

    if (nextText !== line.text) {
      changes.push({ from: line.from, insert: nextText, to: line.to });
    }
  }

  return dispatchLineChanges(view, changes);
}

export function toggleBlockquote(view: EditorView) {
  const lines = selectedLines(view.state);
  const nonSkippedLines = lines.filter((line) => !shouldSkipLineTransform(view.state, line.number));
  const shouldRemove = nonSkippedLines.length > 0 && nonSkippedLines.every((line) => BLOCKQUOTE_PATTERN.test(line.text));
  const changes: ChangeSpec[] = [];

  for (const line of nonSkippedLines) {
    const nextText = shouldRemove
      ? line.text.replace(BLOCKQUOTE_PATTERN, "$1")
      : `${leadingWhitespace(line.text)}> ${line.text.slice(leadingWhitespace(line.text).length)}`;
    if (nextText !== line.text) {
      changes.push({ from: line.from, insert: nextText, to: line.to });
    }
  }

  return dispatchLineChanges(view, changes);
}

export function toggleList(view: EditorView, type: MarkdownListType) {
  const lines = selectedLines(view.state);
  const nonSkippedLines = lines.filter(
    (line) => !shouldSkipLineTransform(view.state, line.number) && !findMarkdownTableRangeAtLine(view.state, line.number),
  );
  const shouldRemove =
    nonSkippedLines.length > 0 && nonSkippedLines.every((line) => readLineListType(line.text) === type);
  const changes: ChangeSpec[] = [];
  let orderedIndex = 1;

  for (const line of nonSkippedLines) {
    const parsed = parseListLine(line.text);
    const indent = parsed?.indent ?? leadingWhitespace(line.text);
    const content = parsed ? line.text.slice(parsed.contentFrom) : line.text.slice(indent.length);
    const checked = parsed?.taskChecked ?? false;
    let nextText: string;

    if (shouldRemove) {
      nextText = `${indent}${content}`;
    } else if (type === "bullet") {
      nextText = `${indent}- ${content}`;
    } else if (type === "ordered") {
      nextText = `${indent}${orderedIndex}. ${content}`;
      orderedIndex += 1;
    } else {
      nextText = `${indent}- [${checked ? "x" : " "}] ${content}`;
    }

    if (nextText !== line.text) {
      changes.push({ from: line.from, insert: nextText, to: line.to });
    }
  }

  return dispatchLineChanges(view, changes);
}

export function insertHorizontalRule(view: EditorView) {
  const selection = view.state.selection.main;
  const insertion = buildBlockInsertion(view.state, selection.from, selection.to, "---");
  view.dispatch({
    changes: {
      from: selection.from,
      insert: insertion.insert,
      to: selection.to,
    },
    selection: { anchor: insertion.anchor },
  });
  return true;
}

export function insertCodeBlock(view: EditorView, language = "") {
  const selection = view.state.selection.main;
  const selectedText = view.state.doc.sliceString(selection.from, selection.to);
  const fence = selectedText.includes("```") ? "~~~" : "```";
  const info = language.trim();
  const block = selectedText
    ? `${fence}${info}\n${selectedText}\n${fence}`
    : `${fence}${info}\n\n${fence}`;
  const insertion = buildBlockInsertion(view.state, selection.from, selection.to, block);
  const cursorOffset = selectedText
    ? insertion.insert.length
    : insertion.insert.indexOf("\n\n") + 1;

  view.dispatch({
    changes: {
      from: selection.from,
      insert: insertion.insert,
      to: selection.to,
    },
    selection: {
      anchor: selection.from + Math.max(0, cursorOffset),
    },
  });
  return true;
}

export function insertFootnote(view: EditorView) {
  const state = view.state;
  const selection = state.selection.main;
  const label = nextFootnoteLabel(state.doc.toString());
  const reference = `[^${label}]`;
  const lineBreak = lineBreakForState(state);
  const docText = state.doc.toString();
  const needsDefinitionPrefix = docText.length === 0 ? "" : docText.endsWith(`${lineBreak}${lineBreak}`) ? "" : docText.endsWith(lineBreak) ? lineBreak : `${lineBreak}${lineBreak}`;
  const definition = `${needsDefinitionPrefix}[^${label}]: `;
  const definitionFrom = state.doc.length;

  view.dispatch({
    changes: [
      {
        from: selection.from,
        insert: reference,
        to: selection.to,
      },
      {
        from: definitionFrom,
        insert: definition,
      },
    ],
    selection: {
      anchor: definitionFrom + definition.length,
    },
  });
  return true;
}

export function insertMarkdownTable(view: EditorView, rows = 3, columns = 3) {
  const columnCount = Math.max(1, Math.min(8, Math.round(columns)));
  const bodyRowCount = Math.max(1, Math.min(12, Math.round(rows)));
  const header = tableRow(Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`));
  const divider = tableRow(Array.from({ length: columnCount }, () => "---"));
  const bodyRows = Array.from({ length: bodyRowCount }, () =>
    tableRow(Array.from({ length: columnCount }, () => "")),
  );
  const block = [header, divider, ...bodyRows].join("\n");
  const selection = view.state.selection.main;
  const insertion = buildBlockInsertion(view.state, selection.from, selection.to, block);

  view.dispatch({
    changes: {
      from: selection.from,
      insert: insertion.insert,
      to: selection.to,
    },
    selection: {
      anchor: insertion.anchor + 2,
      head: insertion.anchor + "Column 1".length + 2,
    },
  });
  return true;
}

export interface MarkdownTableRange {
  endLine: number;
  from: number;
  startLine: number;
  to: number;
}

export function findMarkdownTableRangeAt(state: EditorState, position: number): MarkdownTableRange | null {
  const line = state.doc.lineAt(position);
  return findMarkdownTableRangeAtLine(state, line.number);
}

export function findMarkdownTableRangeAtLine(state: EditorState, lineNumber: number): MarkdownTableRange | null {
  for (const range of collectMarkdownTableRanges(state)) {
    if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
      return range;
    }
  }
  return null;
}

export function collectMarkdownTableRanges(state: EditorState) {
  const ranges: MarkdownTableRange[] = [];
  let line = state.doc.line(1);

  while (line.number < state.doc.lines) {
    const nextLine = state.doc.line(line.number + 1);
    if (looksLikeMarkdownTableHeader(line.text) && TABLE_DIVIDER_PATTERN.test(nextLine.text)) {
      let endLine = nextLine;
      let cursorLineNumber = nextLine.number + 1;
      while (cursorLineNumber <= state.doc.lines) {
        const candidate = state.doc.line(cursorLineNumber);
        if (!looksLikeMarkdownTableRow(candidate.text)) {
          break;
        }
        endLine = candidate;
        cursorLineNumber += 1;
      }

      ranges.push({
        endLine: endLine.number,
        from: line.from,
        startLine: line.number,
        to: endLine.to,
      });
      line = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : endLine;
      if (line.number === endLine.number) {
        break;
      }
      continue;
    }

    line = state.doc.line(line.number + 1);
  }

  return ranges;
}

function toggleSelectedTextInlineStyle(selectedText: string, marker: string) {
  const markerLength = marker.length;
  if (selectedText.startsWith(marker) && selectedText.endsWith(marker) && selectedText.length >= markerLength * 2) {
    return selectedText.slice(markerLength, selectedText.length - markerLength);
  }

  return null;
}

function selectionContainsBacktick(state: EditorState) {
  const selection = state.selection.main;
  return !selection.empty && state.doc.sliceString(selection.from, selection.to).includes("`");
}

function isInlineStyleActiveAtSelection(state: EditorState, marker: MarkdownInlineMarker) {
  const selection = state.selection.main;
  if (!selection.empty) {
    const text = state.doc.sliceString(selection.from, selection.to);
    return text.startsWith(marker) && text.endsWith(marker);
  }

  const beforeRunLength = countRepeatedStringBefore(state, selection.from, marker);
  const afterRunLength = countRepeatedStringAfter(state, selection.from, marker);
  return beforeRunLength > 0 && afterRunLength > 0;
}

function countRepeatedStringBefore(state: EditorState, position: number, marker: string) {
  return state.doc.sliceString(Math.max(0, position - marker.length), position) === marker ? 1 : 0;
}

function countRepeatedStringAfter(state: EditorState, position: number, marker: string) {
  return state.doc.sliceString(position, Math.min(state.doc.length, position + marker.length)) === marker ? 1 : 0;
}

function selectedLines(state: EditorState) {
  const selection = state.selection.main;
  const endPosition =
    selection.to > selection.from && state.doc.lineAt(selection.to).from === selection.to
      ? Math.max(selection.from, selection.to - 1)
      : selection.to;
  const startLine = state.doc.lineAt(selection.from);
  const endLine = state.doc.lineAt(endPosition);
  const lines: Array<ReturnType<EditorState["doc"]["line"]>> = [];
  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    lines.push(state.doc.line(lineNumber));
  }
  return lines;
}

function dispatchLineChanges(view: EditorView, changes: ChangeSpec[]) {
  if (changes.length === 0) {
    return true;
  }
  view.dispatch({ changes });
  return true;
}

function shouldSkipLineTransform(state: EditorState, lineNumber: number) {
  const line = state.doc.line(lineNumber);
  return isPositionInsideFencedCodeBlock(state, line.from) || isPositionInsideFrontmatter(state, line.from);
}

function isPositionInsideFencedCodeBlock(state: EditorState, position: number) {
  const tree = syntaxTree(state);
  let node: SyntaxNode | null = tree.resolveInner(position, 1);
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      return true;
    }
    node = node.parent;
  }

  let inFence = false;
  for (let lineNumber = 1; lineNumber <= state.doc.lineAt(position).number; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (CODE_FENCE_PATTERN.test(line.text)) {
      if (lineNumber === state.doc.lineAt(position).number) {
        return true;
      }
      inFence = !inFence;
    }
  }
  return inFence;
}

function isPositionInsideFrontmatter(state: EditorState, position: number) {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== "---") {
    return false;
  }
  const targetLine = state.doc.lineAt(position).number;
  for (let lineNumber = 2; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (FRONTMATTER_BOUNDARY_PATTERN.test(line.text.trim())) {
      return targetLine <= lineNumber;
    }
  }
  return false;
}

function readLineListType(text: string): MarkdownListType | null {
  if (TASK_LIST_PATTERN.test(text)) {
    return "task";
  }
  if (ORDERED_LIST_PATTERN.test(text)) {
    return "ordered";
  }
  if (BULLET_LIST_PATTERN.test(text)) {
    return "bullet";
  }
  return null;
}

function parseListLine(text: string) {
  const taskMatch = text.match(TASK_LIST_PATTERN);
  if (taskMatch) {
    return {
      contentFrom: taskMatch[0].length,
      indent: taskMatch[1] ?? "",
      taskChecked: (taskMatch[3] ?? " ").toLowerCase() === "x",
      type: "task" as const,
    };
  }

  const orderedMatch = text.match(ORDERED_LIST_PATTERN);
  if (orderedMatch) {
    return {
      contentFrom: orderedMatch[0].length,
      indent: orderedMatch[1] ?? "",
      taskChecked: false,
      type: "ordered" as const,
    };
  }

  const bulletMatch = text.match(BULLET_LIST_PATTERN);
  if (bulletMatch) {
    return {
      contentFrom: bulletMatch[0].length,
      indent: bulletMatch[1] ?? "",
      taskChecked: false,
      type: "bullet" as const,
    };
  }

  return null;
}

function leadingWhitespace(text: string) {
  return text.match(/^\s*/)?.[0] ?? "";
}

function lineBreakForState(state: EditorState) {
  return state.doc.toString().includes("\r\n") ? "\r\n" : "\n";
}

function buildBlockInsertion(state: EditorState, from: number, to: number, block: string) {
  const lineBreak = lineBreakForState(state);
  const before = state.doc.sliceString(Math.max(0, from - 2), from);
  const after = state.doc.sliceString(to, Math.min(state.doc.length, to + 2));
  const normalizedBlock = block.replace(/\n/g, lineBreak);
  const prefix =
    from === 0 ? "" : before.endsWith(`${lineBreak}${lineBreak}`) ? "" : before.endsWith(lineBreak) ? lineBreak : `${lineBreak}${lineBreak}`;
  const suffix =
    to === state.doc.length
      ? ""
      : after.startsWith(`${lineBreak}${lineBreak}`)
        ? ""
        : after.startsWith(lineBreak)
          ? lineBreak
          : `${lineBreak}${lineBreak}`;

  return {
    anchor: from + prefix.length,
    insert: `${prefix}${normalizedBlock}${suffix}`,
  };
}

function nextFootnoteLabel(content: string) {
  const used = new Set<number>();
  for (const match of content.matchAll(FOOTNOTE_REFERENCE_PATTERN)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(value)) {
      used.add(value);
    }
  }

  for (let value = 1; value < 10_000; value += 1) {
    if (!used.has(value)) {
      return String(value);
    }
  }

  return String(used.size + 1);
}

function tableRow(cells: string[]) {
  return `| ${cells.join(" | ")} |`;
}

function looksLikeMarkdownTableHeader(text: string) {
  const trimmed = text.trim();
  const pipeCount = (trimmed.match(/\|/g) ?? []).length;
  return pipeCount >= 2 || trimmed.startsWith("|") || trimmed.endsWith("|");
}

function looksLikeMarkdownTableRow(text: string) {
  return text.trim().length > 0 && TABLE_ROW_PATTERN.test(text);
}
