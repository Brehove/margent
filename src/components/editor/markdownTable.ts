import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  findMarkdownTableRangeAt,
  type MarkdownTableRange,
} from "./markdownFormatting";

export type MarkdownTableAlignment = "left" | "center" | "right" | "none";
export type MarkdownTableCommand =
  | "row-above"
  | "row-below"
  | "column-left"
  | "column-right"
  | "delete-row"
  | "delete-column"
  | "align-left"
  | "align-center"
  | "align-right"
  | "align-none"
  | "tidy";

export interface MarkdownTableCellSpan {
  contentFrom: number;
  contentTo: number;
  from: number;
  to: number;
}

export interface MarkdownTableCell extends MarkdownTableCellSpan {
  columnIndex: number;
  isMissing: boolean;
  rowIndex: number;
  text: string;
}

export type MarkdownTableRowKind = "header" | "divider" | "body";

export interface MarkdownTableRow {
  cells: MarkdownTableCell[];
  from: number;
  kind: MarkdownTableRowKind;
  lineNumber: number;
  rowIndex: number;
  text: string;
  to: number;
}

export interface MarkdownTableContext {
  alignments: MarkdownTableAlignment[];
  cellSpan: MarkdownTableCellSpan;
  columnCount: number;
  currentCell: MarkdownTableCell;
  currentColumn: number;
  currentRow: number;
  range: MarkdownTableRange;
  rows: MarkdownTableRow[];
}

interface ParsedMarkdownTable {
  alignments: MarkdownTableAlignment[];
  columnCount: number;
  range: MarkdownTableRange;
  rows: MarkdownTableRow[];
}

interface MarkdownTableModel {
  alignments: MarkdownTableAlignment[];
  columnCount: number;
  rows: string[][];
}

interface RenderedTable {
  cellSpans: MarkdownTableCellSpan[][];
  text: string;
}

type RenderMode = "compact" | "tidy";

export function getMarkdownTableContext(
  state: EditorState,
  position = state.selection.main.from,
): MarkdownTableContext | null {
  const range = findMarkdownTableRangeAt(state, position);
  if (!range) {
    return null;
  }

  const table = parseMarkdownTable(state, range);
  const line = state.doc.lineAt(clamp(position, range.from, range.to));
  const currentRow = line.number - range.startLine;
  const row = table.rows[currentRow];
  if (!row) {
    return null;
  }

  const currentColumn = findCellColumnAt(row, position, table.columnCount);
  const currentCell = readCell(row, currentColumn);

  return {
    alignments: table.alignments,
    cellSpan: {
      contentFrom: currentCell.contentFrom,
      contentTo: currentCell.contentTo,
      from: currentCell.from,
      to: currentCell.to,
    },
    columnCount: table.columnCount,
    currentCell,
    currentColumn,
    currentRow,
    range,
    rows: table.rows,
  };
}

export function moveMarkdownTableCell(view: EditorView, direction: number) {
  if (direction === 0) {
    return false;
  }

  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const step = direction < 0 ? -1 : 1;
  const editableCells = collectEditableCells(context.rows.length, context.columnCount);
  const originRow = context.currentRow === 1 ? 0 : context.currentRow;
  const originIndex = editableCells.findIndex(
    (cell) => cell.row === originRow && cell.column === context.currentColumn,
  );
  if (originIndex < 0) {
    return false;
  }

  const targetIndex = originIndex + step;
  if (targetIndex < 0) {
    return false;
  }

  const parsedTable = parseMarkdownTable(view.state, context.range);
  const model = tableModelFromParsed(parsedTable);

  if (targetIndex >= editableCells.length) {
    model.rows.push(Array.from({ length: model.columnCount }, () => ""));
    return replaceMarkdownTable(view, parsedTable, model, "compact", {
      column: 0,
      row: model.rows.length - 1,
    });
  }

  const target = editableCells[targetIndex];
  const targetRow = context.rows[target.row];
  const targetCell = targetRow ? targetRow.cells[target.column] : null;
  if (targetCell && !targetCell.isMissing) {
    selectMarkdownTableCell(view, targetCell);
    return true;
  }

  return replaceMarkdownTable(view, parsedTable, model, "compact", target);
}

export function insertMarkdownTableRow(
  view: EditorView,
  position: "above" | "below",
) {
  const parsedTable = readCurrentParsedTable(view.state);
  if (!parsedTable) {
    return false;
  }

  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const model = tableModelFromParsed(parsedTable);
  const insertionRow =
    context.currentRow < 2
      ? 2
      : context.currentRow + (position === "below" ? 1 : 0);
  model.rows.splice(insertionRow, 0, Array.from({ length: model.columnCount }, () => ""));

  return replaceMarkdownTable(view, parsedTable, model, "compact", {
    column: Math.min(context.currentColumn, model.columnCount - 1),
    row: insertionRow,
  });
}

export function insertMarkdownTableColumn(
  view: EditorView,
  position: "left" | "right",
) {
  const parsedTable = readCurrentParsedTable(view.state);
  if (!parsedTable) {
    return false;
  }

  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const model = tableModelFromParsed(parsedTable);
  const insertionColumn =
    context.currentColumn + (position === "right" ? 1 : 0);
  for (const row of model.rows) {
    row.splice(insertionColumn, 0, "");
  }
  model.alignments.splice(insertionColumn, 0, "none");
  model.columnCount += 1;

  return replaceMarkdownTable(view, parsedTable, model, "compact", {
    column: insertionColumn,
    row: selectableRowAfterStructureChange(context.currentRow, model.rows.length),
  });
}

export function deleteMarkdownTableRow(view: EditorView) {
  const parsedTable = readCurrentParsedTable(view.state);
  if (!parsedTable) {
    return false;
  }

  const context = getMarkdownTableContext(view.state);
  if (!context || context.currentRow < 2) {
    return false;
  }

  const model = tableModelFromParsed(parsedTable);
  model.rows.splice(context.currentRow, 1);
  const targetRow =
    model.rows.length > 2
      ? clamp(context.currentRow, 2, model.rows.length - 1)
      : 0;

  return replaceMarkdownTable(view, parsedTable, model, "compact", {
    column: Math.min(context.currentColumn, model.columnCount - 1),
    row: targetRow,
  });
}

export function deleteMarkdownTableColumn(view: EditorView) {
  const parsedTable = readCurrentParsedTable(view.state);
  if (!parsedTable || parsedTable.columnCount <= 1) {
    return false;
  }

  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const model = tableModelFromParsed(parsedTable);
  for (const row of model.rows) {
    row.splice(context.currentColumn, 1);
  }
  model.alignments.splice(context.currentColumn, 1);
  model.columnCount -= 1;

  return replaceMarkdownTable(view, parsedTable, model, "compact", {
    column: Math.min(context.currentColumn, model.columnCount - 1),
    row: selectableRowAfterStructureChange(context.currentRow, model.rows.length),
  });
}

export function setMarkdownTableColumnAlignment(
  view: EditorView,
  alignment: MarkdownTableAlignment,
) {
  const parsedTable = readCurrentParsedTable(view.state);
  if (!parsedTable) {
    return false;
  }

  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const model = tableModelFromParsed(parsedTable);
  model.alignments[context.currentColumn] = alignment;

  return replaceMarkdownTable(view, parsedTable, model, "compact", {
    column: context.currentColumn,
    row: selectableRowAfterStructureChange(context.currentRow, model.rows.length),
  });
}

export function tidyMarkdownTable(view: EditorView) {
  const parsedTable = readCurrentParsedTable(view.state);
  if (!parsedTable) {
    return false;
  }

  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const model = tableModelFromParsed(parsedTable);
  return replaceMarkdownTable(view, parsedTable, model, "tidy", {
    column: Math.min(context.currentColumn, model.columnCount - 1),
    row: selectableRowAfterStructureChange(context.currentRow, model.rows.length),
  });
}

function readCurrentParsedTable(state: EditorState) {
  const context = getMarkdownTableContext(state);
  return context ? parseMarkdownTable(state, context.range) : null;
}

function parseMarkdownTable(
  state: EditorState,
  range: MarkdownTableRange,
): ParsedMarkdownTable {
  const rows: MarkdownTableRow[] = [];
  for (let lineNumber = range.startLine; lineNumber <= range.endLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    rows.push(parseMarkdownTableRow(line.text, line.from, line.to, lineNumber, range.startLine));
  }

  const columnCount = Math.max(1, ...rows.map((row) => row.cells.length));
  const divider = rows[1];
  const alignments = Array.from({ length: columnCount }, (_, columnIndex) =>
    readMarkdownTableAlignment(divider?.cells[columnIndex]?.text ?? ""),
  );

  return {
    alignments,
    columnCount,
    range,
    rows,
  };
}

function parseMarkdownTableRow(
  text: string,
  lineFrom: number,
  lineTo: number,
  lineNumber: number,
  tableStartLine: number,
): MarkdownTableRow {
  const rowIndex = lineNumber - tableStartLine;
  const segments = collectMarkdownTableCellSegments(text);
  const cells = segments.map((segment, columnIndex) =>
    createMarkdownTableCell(text, lineFrom, rowIndex, columnIndex, segment.from, segment.to, false),
  );

  return {
    cells,
    from: lineFrom,
    kind: rowIndex === 0 ? "header" : rowIndex === 1 ? "divider" : "body",
    lineNumber,
    rowIndex,
    text,
    to: lineTo,
  };
}

function collectMarkdownTableCellSegments(text: string) {
  const separators = collectUnescapedPipeIndexes(text);
  if (separators.length === 0) {
    return [{ from: 0, to: text.length }];
  }

  const segments: Array<{ from: number; to: number }> = [];
  let segmentStart = 0;
  for (const separator of separators) {
    segments.push({ from: segmentStart, to: separator });
    segmentStart = separator + 1;
  }
  segments.push({ from: segmentStart, to: text.length });

  const firstSeparator = separators[0] ?? 0;
  const lastSeparator = separators[separators.length - 1] ?? text.length;
  const hasLeadingPipe = text.slice(0, firstSeparator).trim().length === 0;
  const hasTrailingPipe = text.slice(lastSeparator + 1).trim().length === 0;

  if (hasLeadingPipe) {
    segments.shift();
  }
  if (hasTrailingPipe) {
    segments.pop();
  }

  return segments.length > 0 ? segments : [{ from: 0, to: text.length }];
}

function collectUnescapedPipeIndexes(text: string) {
  const indexes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|" && !isEscaped(text, index)) {
      indexes.push(index);
    }
  }
  return indexes;
}

function isEscaped(text: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function createMarkdownTableCell(
  lineText: string,
  lineFrom: number,
  rowIndex: number,
  columnIndex: number,
  segmentFrom: number,
  segmentTo: number,
  isMissing: boolean,
): MarkdownTableCell {
  const raw = lineText.slice(segmentFrom, segmentTo);
  const leadingSpaceLength = raw.match(/^[ \t]*/)?.[0].length ?? 0;
  const trailingSpaceLength = raw.match(/[ \t]*$/)?.[0].length ?? 0;
  const contentStart = leadingSpaceLength;
  const contentEnd = Math.max(contentStart, raw.length - trailingSpaceLength);

  return {
    columnIndex,
    contentFrom: lineFrom + segmentFrom + contentStart,
    contentTo: lineFrom + segmentFrom + contentEnd,
    from: lineFrom + segmentFrom,
    isMissing,
    rowIndex,
    text: raw.slice(contentStart, contentEnd),
    to: lineFrom + segmentTo,
  };
}

function readCell(row: MarkdownTableRow, columnIndex: number): MarkdownTableCell {
  return (
    row.cells[columnIndex] ??
    {
      columnIndex,
      contentFrom: row.to,
      contentTo: row.to,
      from: row.to,
      isMissing: true,
      rowIndex: row.rowIndex,
      text: "",
      to: row.to,
    }
  );
}

function findCellColumnAt(
  row: MarkdownTableRow,
  position: number,
  columnCount: number,
) {
  if (row.cells.length === 0) {
    return 0;
  }

  const boundedPosition = clamp(position, row.from, row.to);
  for (const cell of row.cells) {
    if (boundedPosition <= cell.to) {
      return Math.min(cell.columnIndex, columnCount - 1);
    }
  }

  return Math.min(row.cells.length - 1, columnCount - 1);
}

function tableModelFromParsed(table: ParsedMarkdownTable): MarkdownTableModel {
  return {
    alignments: normalizeAlignments(table.alignments, table.columnCount),
    columnCount: table.columnCount,
    rows: table.rows.map((row) =>
      row.kind === "divider"
        ? dividerCellsForAlignments(table.alignments, table.columnCount)
        : normalizeCellTexts(
            row.cells.map((cell) => cell.text),
            table.columnCount,
          ),
    ),
  };
}

function normalizeCellTexts(cells: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, columnIndex) => cells[columnIndex] ?? "");
}

function normalizeAlignments(
  alignments: MarkdownTableAlignment[],
  columnCount: number,
) {
  return Array.from({ length: columnCount }, (_, columnIndex) => alignments[columnIndex] ?? "none");
}

function readMarkdownTableAlignment(text: string): MarkdownTableAlignment {
  const trimmed = text.trim();
  const starts = trimmed.startsWith(":");
  const ends = trimmed.endsWith(":");
  if (starts && ends) {
    return "center";
  }
  if (starts) {
    return "left";
  }
  if (ends) {
    return "right";
  }
  return "none";
}

function dividerCellsForAlignments(
  alignments: MarkdownTableAlignment[],
  columnCount: number,
) {
  return Array.from({ length: columnCount }, (_, columnIndex) =>
    compactDividerCell(alignments[columnIndex] ?? "none"),
  );
}

function compactDividerCell(alignment: MarkdownTableAlignment) {
  switch (alignment) {
    case "center":
      return ":---:";
    case "left":
      return ":---";
    case "right":
      return "---:";
    case "none":
      return "---";
  }
}

function replaceMarkdownTable(
  view: EditorView,
  table: ParsedMarkdownTable,
  model: MarkdownTableModel,
  mode: RenderMode,
  selectionTarget: { column: number; row: number },
) {
  const rendered = renderMarkdownTable(model, mode, lineBreakForState(view.state));
  const targetSpan = rendered.cellSpans[selectionTarget.row]?.[selectionTarget.column];
  const selectionFrom = table.range.from + (targetSpan?.contentFrom ?? 0);
  const selectionTo = table.range.from + (targetSpan?.contentTo ?? 0);

  view.dispatch({
    changes: {
      from: table.range.from,
      insert: rendered.text,
      to: table.range.to,
    },
    scrollIntoView: true,
    selection: {
      anchor: selectionFrom,
      head: selectionTo,
    },
  });
  return true;
}

function renderMarkdownTable(
  model: MarkdownTableModel,
  mode: RenderMode,
  lineBreak: string,
): RenderedTable {
  const rows = model.rows.map((row, rowIndex) =>
    rowIndex === 1
      ? dividerCellsForAlignments(model.alignments, model.columnCount)
      : normalizeCellTexts(row, model.columnCount),
  );
  const widths = mode === "tidy" ? calculateColumnWidths(rows, model.alignments) : [];
  const lines: string[] = [];
  const cellSpans: MarkdownTableCellSpan[][] = [];
  let logicalOffset = 0;

  rows.forEach((row, rowIndex) => {
    const renderedLine = renderMarkdownTableRow(
      rowIndex === 1 && mode === "tidy"
        ? tidyDividerCells(model.alignments, widths)
        : row,
      mode === "tidy" ? widths : null,
    );
    lines.push(renderedLine.text);
    cellSpans.push(
      renderedLine.cellSpans.map((span) => ({
        contentFrom: span.contentFrom + logicalOffset,
        contentTo: span.contentTo + logicalOffset,
        from: span.from + logicalOffset,
        to: span.to + logicalOffset,
      })),
    );
    logicalOffset += renderedLine.text.length + 1;
  });

  return {
    cellSpans,
    text: lines.join(lineBreak),
  };
}

function renderMarkdownTableRow(cells: string[], widths: number[] | null) {
  const renderedSpans: MarkdownTableCellSpan[] = [];
  let text = "|";

  cells.forEach((cell, columnIndex) => {
    const width = widths?.[columnIndex] ?? cell.length;
    const paddedCell = widths ? cell.padEnd(width, " ") : cell;
    const cellFrom = text.length + 1;
    const contentFrom = cellFrom;
    const contentTo = contentFrom + cell.length;
    text += ` ${paddedCell} |`;
    renderedSpans.push({
      contentFrom,
      contentTo,
      from: cellFrom,
      to: cellFrom + paddedCell.length,
    });
  });

  return {
    cellSpans: renderedSpans,
    text,
  };
}

function calculateColumnWidths(
  rows: string[][],
  alignments: MarkdownTableAlignment[],
) {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const contentWidth = Math.max(
      0,
      ...rows.map((row) => row[columnIndex]?.length ?? 0),
    );
    const dividerWidth = compactDividerCell(alignments[columnIndex] ?? "none").length;
    return Math.max(contentWidth, dividerWidth);
  });
}

function tidyDividerCells(
  alignments: MarkdownTableAlignment[],
  widths: number[],
) {
  return widths.map((width, columnIndex) => {
    const alignment = alignments[columnIndex] ?? "none";
    switch (alignment) {
      case "center":
        return `:${"-".repeat(Math.max(3, width - 2))}:`;
      case "left":
        return `:${"-".repeat(Math.max(3, width - 1))}`;
      case "right":
        return `${"-".repeat(Math.max(3, width - 1))}:`;
      case "none":
        return "-".repeat(Math.max(3, width));
    }
  });
}

function selectMarkdownTableCell(view: EditorView, cell: MarkdownTableCell) {
  view.dispatch({
    scrollIntoView: true,
    selection: {
      anchor: cell.contentFrom,
      head: cell.contentTo,
    },
  });
}

function collectEditableCells(rowCount: number, columnCount: number) {
  const cells: Array<{ column: number; row: number }> = [];
  for (let row = 0; row < rowCount; row += 1) {
    if (row === 1) {
      continue;
    }
    for (let column = 0; column < columnCount; column += 1) {
      cells.push({ column, row });
    }
  }
  return cells;
}

function selectableRowAfterStructureChange(row: number, rowCount: number) {
  if (row === 1) {
    return 0;
  }
  return clamp(row, 0, rowCount - 1);
}

function lineBreakForState(state: EditorState) {
  return state.facet(EditorState.lineSeparator) ?? "\n";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
