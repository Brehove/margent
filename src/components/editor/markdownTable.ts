import { syntaxTree } from "@codemirror/language";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

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
  | "move-row-up"
  | "move-row-down"
  | "move-column-left"
  | "move-column-right"
  | "tidy";

export interface MarkdownTableRange {
  endLine: number;
  from: number;
  kind: "source-fallback";
  startLine: number;
  to: number;
}

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

export interface MarkdownTableModel {
  alignments: MarkdownTableAlignment[];
  columnCount: number;
  lineBreak: "\n" | "\r\n";
  range: MarkdownTableRange;
  rows: MarkdownTableRow[];
}

interface RenderedTable {
  cellSpans: MarkdownTableCellSpan[][];
  text: string;
}

type RenderMode = "compact" | "tidy";

const tableRangesCache = new WeakMap<EditorState, MarkdownTableRange[]>();
const tableModelsCache = new WeakMap<EditorState, MarkdownTableModel[]>();

export function collectMarkdownTableRanges(state: EditorState): MarkdownTableRange[] {
  const cached = tableRangesCache.get(state);
  if (cached) {
    return cached;
  }

  const ranges = collectMarkdownTableModels(state).map((model) => model.range);
  tableRangesCache.set(state, ranges);
  return ranges;
}

export function findMarkdownTableRangeAt(
  state: EditorState,
  position: number,
): MarkdownTableRange | null {
  const line = state.doc.lineAt(clamp(position, 0, state.doc.length));
  return findMarkdownTableRangeAtLine(state, line.number);
}

export function findMarkdownTableRangeAtLine(
  state: EditorState,
  lineNumber: number,
): MarkdownTableRange | null {
  return (
    collectMarkdownTableRanges(state).find(
      (range) => lineNumber >= range.startLine && lineNumber <= range.endLine,
    ) ?? null
  );
}

export function getTableModelAt(
  state: EditorState,
  position = state.selection.main.from,
): MarkdownTableModel | null {
  const line = state.doc.lineAt(clamp(position, 0, state.doc.length));
  return (
    collectMarkdownTableModels(state).find(
      (model) =>
        line.number >= model.range.startLine &&
        line.number <= model.range.endLine,
    ) ?? null
  );
}

export function getMarkdownTableContext(
  state: EditorState,
  position = state.selection.main.from,
): MarkdownTableContext | null {
  const model = getTableModelAt(state, position);
  if (!model) {
    return null;
  }

  const line = state.doc.lineAt(clamp(position, model.range.from, model.range.to));
  const currentRow = line.number - model.range.startLine;
  const row = model.rows[currentRow];
  if (!row) {
    return null;
  }

  const currentColumn = findCellColumnAt(row, position, model.columnCount);
  const currentCell = readCell(row, currentColumn);

  return {
    alignments: model.alignments,
    cellSpan: {
      contentFrom: currentCell.contentFrom,
      contentTo: currentCell.contentTo,
      from: currentCell.from,
      to: currentCell.to,
    },
    columnCount: model.columnCount,
    currentCell,
    currentColumn,
    currentRow,
    range: model.range,
    rows: model.rows,
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

  if (targetIndex >= editableCells.length) {
    return appendMarkdownTableRow(view, context);
  }

  const target = editableCells[targetIndex];
  const targetRow = context.rows[target.row];
  const targetCell = targetRow ? readCell(targetRow, target.column) : null;
  if (!targetCell) {
    return false;
  }

  selectMarkdownTableCell(view, targetCell);
  return true;
}

export function insertMarkdownTableRow(
  view: EditorView,
  position: "above" | "below",
) {
  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  if (position === "above" && context.currentRow < 2) {
    return false;
  }

  const insertBeforeRow =
    context.currentRow < 2
      ? 2
      : context.currentRow + (position === "below" ? 1 : 0);
  const insertLine = compactTableRow(Array.from({ length: context.columnCount }, () => ""));
  const change = buildLineInsertion(view.state, context, insertBeforeRow, insertLine);
  const selection = insertedCellSelection(change.from, context.currentColumn);

  view.dispatch({
    changes: change,
    scrollIntoView: true,
    selection,
  });
  return true;
}

export function insertMarkdownTableColumn(
  view: EditorView,
  position: "left" | "right",
) {
  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const insertionColumn = context.currentColumn + (position === "right" ? 1 : 0);
  const changes = context.rows.map((row) =>
    buildColumnInsertionChange(row, context.columnCount, insertionColumn),
  );

  view.dispatch({
    changes,
    scrollIntoView: true,
  });
  selectCellByRowColumn(view, selectableRowAfterStructureChange(context.currentRow, context.rows.length), insertionColumn);
  return true;
}

export function deleteMarkdownTableRow(view: EditorView) {
  const context = getMarkdownTableContext(view.state);
  if (!context || context.currentRow < 2) {
    return false;
  }

  const row = context.rows[context.currentRow];
  if (!row) {
    return false;
  }

  const change = buildLineDeletion(view.state, row.lineNumber);
  view.dispatch({
    changes: change,
    scrollIntoView: true,
  });
  const nextRow = clamp(context.currentRow, 2, context.rows.length - 2);
  selectCellByRowColumn(view, nextRow, Math.min(context.currentColumn, context.columnCount - 1));
  return true;
}

export function deleteMarkdownTableColumn(view: EditorView) {
  const context = getMarkdownTableContext(view.state);
  if (!context || context.columnCount <= 1) {
    return false;
  }

  const columnToDelete = context.currentColumn;
  const changes = context.rows.map((row) =>
    buildColumnDeletionChange(row, context.columnCount, columnToDelete),
  );

  view.dispatch({
    changes,
    scrollIntoView: true,
  });
  selectCellByRowColumn(
    view,
    selectableRowAfterStructureChange(context.currentRow, context.rows.length),
    Math.min(columnToDelete, context.columnCount - 2),
  );
  return true;
}

export function setMarkdownTableColumnAlignment(
  view: EditorView,
  alignment: MarkdownTableAlignment,
) {
  const context = getMarkdownTableContext(view.state);
  if (!context) {
    return false;
  }

  const divider = context.rows[1];
  if (!divider) {
    return false;
  }

  const cell = readRawCellSpan(divider, context.currentColumn);
  const rawCell = divider.text.slice(cell.from - divider.from, cell.to - divider.from);
  view.dispatch({
    changes: {
      from: cell.from,
      insert: alignmentCellForRawCell(rawCell, alignment),
      to: cell.to,
    },
    scrollIntoView: true,
  });
  selectCellByRowColumn(view, selectableRowAfterStructureChange(context.currentRow, context.rows.length), context.currentColumn);
  return true;
}

export function tidyMarkdownTable(view: EditorView) {
  const model = getTableModelAt(view.state);
  const context = getMarkdownTableContext(view.state);
  if (!model || !context) {
    return false;
  }

  const rendered = renderMarkdownTable(modelFromRows(model), "tidy", model.lineBreak);
  const targetSpan = rendered.cellSpans[context.currentRow]?.[context.currentColumn];
  const selectionFrom = model.range.from + (targetSpan?.contentFrom ?? 0);
  const selectionTo = model.range.from + (targetSpan?.contentTo ?? 0);

  view.dispatch({
    changes: {
      from: model.range.from,
      insert: rendered.text,
      to: model.range.to,
    },
    scrollIntoView: true,
    selection: {
      anchor: selectionFrom,
      head: selectionTo,
    },
  });
  return true;
}

function collectMarkdownTableModels(state: EditorState): MarkdownTableModel[] {
  const cached = tableModelsCache.get(state);
  if (cached) {
    return cached;
  }

  const models: MarkdownTableModel[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") {
        return;
      }

      const model = buildTableModelFromNode(state, node.node);
      if (model) {
        models.push(model);
      }
    },
  });
  tableModelsCache.set(state, models);
  return models;
}

function buildTableModelFromNode(
  state: EditorState,
  tableNode: SyntaxNode,
): MarkdownTableModel | null {
  const startLine = state.doc.lineAt(tableNode.from);
  const endLine = state.doc.lineAt(Math.max(tableNode.from, tableNode.to - 1));
  const range: MarkdownTableRange = {
    endLine: endLine.number,
    from: startLine.from,
    kind: "source-fallback",
    startLine: startLine.number,
    to: endLine.to,
  };
  const rows: MarkdownTableRow[] = [];
  let headerNode: SyntaxNode | null = null;
  const bodyNodes: SyntaxNode[] = [];

  for (let child = tableNode.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader") {
      headerNode = child;
    } else if (child.name === "TableRow") {
      bodyNodes.push(child);
    }
  }

  if (!headerNode || startLine.number + 1 > state.doc.lines) {
    return null;
  }

  const headerLine = state.doc.lineAt(headerNode.from);
  const dividerLine = state.doc.line(startLine.number + 1);
  rows.push(createRowFromTableCells(state, headerNode, range.startLine, "header"));
  rows.push(createDividerRow(dividerLine, range.startLine));
  for (const rowNode of bodyNodes) {
    rows.push(createRowFromTableCells(state, rowNode, range.startLine, "body"));
  }

  const columnCount = Math.max(1, ...rows.map((row) => row.cells.length));
  const alignments = readDividerAlignments(dividerLine.text, columnCount);

  if (headerLine.number !== range.startLine || rows.length < 2) {
    return null;
  }

  return {
    alignments,
    columnCount,
    lineBreak: lineBreakForState(state),
    range,
    rows,
  };
}

function createRowFromTableCells(
  state: EditorState,
  rowNode: SyntaxNode,
  tableStartLine: number,
  kind: MarkdownTableRowKind,
): MarkdownTableRow {
  const line = state.doc.lineAt(rowNode.from);
  const rowIndex = line.number - tableStartLine;
  const cells: MarkdownTableCell[] = [];
  for (let child = rowNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableCell") {
      continue;
    }

    cells.push({
      columnIndex: cells.length,
      contentFrom: child.from,
      contentTo: child.to,
      from: child.from,
      isMissing: false,
      rowIndex,
      text: state.doc.sliceString(child.from, child.to),
      to: child.to,
    });
  }

  return {
    cells,
    from: line.from,
    kind,
    lineNumber: line.number,
    rowIndex,
    text: line.text,
    to: line.to,
  };
}

function createDividerRow(
  line: ReturnType<EditorState["doc"]["line"]>,
  tableStartLine: number,
): MarkdownTableRow {
  const rowIndex = line.number - tableStartLine;
  const segments = collectMarkdownTableCellSegments(line.text);
  return {
    cells: segments.map((segment, columnIndex) =>
      createMarkdownTableCell(line.text, line.from, rowIndex, columnIndex, segment.from, segment.to, false),
    ),
    from: line.from,
    kind: "divider",
    lineNumber: line.number,
    rowIndex,
    text: line.text,
    to: line.to,
  };
}

function readDividerAlignments(
  dividerText: string,
  columnCount: number,
): MarkdownTableAlignment[] {
  const cells = readRawCells(dividerText, columnCount, " --- ");
  return Array.from({ length: columnCount }, (_, columnIndex) =>
    readMarkdownTableAlignment(cells[columnIndex] ?? ""),
  );
}

function appendMarkdownTableRow(view: EditorView, context: MarkdownTableContext) {
  const insertLine = compactTableRow(Array.from({ length: context.columnCount }, () => ""));
  const change = buildLineInsertion(view.state, context, context.rows.length, insertLine);
  view.dispatch({
    changes: change,
    scrollIntoView: true,
    selection: insertedCellSelection(change.from, 0),
  });
  return true;
}

function buildLineInsertion(
  state: EditorState,
  context: MarkdownTableContext,
  insertBeforeRow: number,
  lineText: string,
) {
  const boundedRow = clamp(insertBeforeRow, 0, context.rows.length);
  if (boundedRow >= context.rows.length) {
    return {
      from: context.range.to,
      insert: `${lineBreakForState(state)}${lineText}`,
    };
  }

  const targetRow = context.rows[boundedRow];
  return {
    from: targetRow.from,
    insert: `${lineText}${lineBreakForState(state)}`,
  };
}

function buildLineDeletion(state: EditorState, lineNumber: number): ChangeSpec {
  const line = state.doc.line(lineNumber);
  if (lineNumber < state.doc.lines) {
    const nextLine = state.doc.line(lineNumber + 1);
    return { from: line.from, to: nextLine.from };
  }
  if (lineNumber > 1) {
    const previousLine = state.doc.line(lineNumber - 1);
    return { from: previousLine.to, to: line.to };
  }
  return { from: line.from, to: line.to };
}

function insertedCellSelection(lineFrom: number, column: number) {
  const anchor = lineFrom + 2 + Math.max(0, column) * 3;
  return { anchor };
}

function selectCellByRowColumn(view: EditorView, rowIndex: number, columnIndex: number) {
  const context = getMarkdownTableContext(view.state);
  const row = context?.rows[rowIndex];
  const cell = row ? readCell(row, columnIndex) : null;
  if (!cell) {
    return;
  }
  selectMarkdownTableCell(view, cell);
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

function modelFromRows(table: MarkdownTableModel) {
  return {
    alignments: normalizeAlignments(table.alignments, table.columnCount),
    columnCount: table.columnCount,
    rows: table.rows.map((row) =>
      row.kind === "divider"
        ? dividerCellsForAlignments(table.alignments, table.columnCount)
        : normalizeCellTexts(
            Array.from({ length: table.columnCount }, (_, columnIndex) => readCell(row, columnIndex).text),
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

function renderMarkdownTable(
  model: { alignments: MarkdownTableAlignment[]; columnCount: number; rows: string[][] },
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
    logicalOffset += renderedLine.text.length + lineBreak.length;
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

function readRawCells(text: string, columnCount: number, fillCell: string) {
  const segments = collectMarkdownTableCellSegments(text);
  const cells = segments.map((segment) => text.slice(segment.from, segment.to));
  while (cells.length < columnCount) {
    cells.push(fillCell);
  }
  return cells.slice(0, Math.max(columnCount, cells.length));
}

function buildColumnInsertionChange(
  row: MarkdownTableRow,
  columnCount: number,
  insertionColumn: number,
): ChangeSpec {
  const boundedColumn = clamp(insertionColumn, 0, columnCount);
  const cellText = row.kind === "divider" ? " --- " : "  ";
  const pipeIndexes = collectUnescapedPipeIndexes(row.text);
  const firstPipeIndex = pipeIndexes[0] ?? -1;
  const lastPipeIndex = pipeIndexes[pipeIndexes.length - 1] ?? -1;
  const hasLeadingPipe =
    firstPipeIndex >= 0 && row.text.slice(0, firstPipeIndex).trim().length === 0;
  const hasTrailingPipe =
    lastPipeIndex >= 0 && row.text.slice(lastPipeIndex + 1).trim().length === 0;

  if (boundedColumn === 0) {
    return {
      from: row.from + (hasLeadingPipe ? firstPipeIndex + 1 : 0),
      insert: hasLeadingPipe ? `${cellText}|` : `${cellText}| `,
    };
  }

  const previousCell = readRawCellSpan(row, boundedColumn - 1);
  const isAppending = boundedColumn >= rawCellCount(row);
  return {
    from: previousCell.to,
    insert: isAppending && !hasTrailingPipe ? ` |${cellText}` : `|${cellText}`,
  };
}

function buildColumnDeletionChange(
  row: MarkdownTableRow,
  columnCount: number,
  columnToDelete: number,
): ChangeSpec {
  const boundedColumn = clamp(columnToDelete, 0, columnCount - 1);
  const targetCell = readRawCellSpan(row, boundedColumn);
  const pipeIndexes = collectUnescapedPipeIndexes(row.text);
  const firstPipeIndex = pipeIndexes[0] ?? -1;
  const hasLeadingPipe =
    firstPipeIndex >= 0 && row.text.slice(0, firstPipeIndex).trim().length === 0;

  if (boundedColumn === 0) {
    const nextCell = readRawCellSpan(row, 1);
    const from = hasLeadingPipe ? targetCell.from : row.from;
    const to = !nextCell.isMissing ? nextCell.from : targetCell.to;
    return { from, to };
  }

  const previousCell = readRawCellSpan(row, boundedColumn - 1);
  return {
    from: previousCell.to,
    to: targetCell.to,
  };
}

function readRawCellSpan(row: MarkdownTableRow, columnIndex: number) {
  const segments = collectMarkdownTableCellSegments(row.text);
  const segment = segments[columnIndex];
  if (!segment) {
    return {
      from: row.to,
      isMissing: true,
      to: row.to,
    };
  }

  return {
    from: row.from + segment.from,
    isMissing: false,
    to: row.from + segment.to,
  };
}

function rawCellCount(row: MarkdownTableRow) {
  return collectMarkdownTableCellSegments(row.text).length;
}

function alignmentCellForRawCell(
  rawCell: string,
  alignment: MarkdownTableAlignment,
) {
  const leading = rawCell.match(/^[ \t]*/)?.[0] ?? "";
  const trailing = rawCell.match(/[ \t]*$/)?.[0] ?? "";
  const marker = compactDividerCell(alignment);
  return `${leading}${marker}${trailing}`;
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

function compactTableRow(cells: string[]) {
  return `| ${cells.join(" | ")} |`;
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

function lineBreakForState(state: EditorState): "\n" | "\r\n" {
  return state.facet(EditorState.lineSeparator) === "\r\n" ? "\r\n" : "\n";
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
