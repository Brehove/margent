import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  getMarkdownTableContext,
  insertMarkdownTableColumn,
  moveMarkdownTableCell,
  setMarkdownTableColumnAlignment,
  tidyMarkdownTable,
} from "../src/components/editor/markdownTable";

function createView(doc: string, selectionText: string) {
  const anchor = doc.indexOf(selectionText);
  if (anchor < 0) {
    throw new Error(`Selection text not found: ${selectionText}`);
  }

  return new EditorView({
    doc,
    selection: { anchor },
  });
}

describe("markdown table editing helpers", () => {
  it("detects the current cell without splitting escaped pipes", () => {
    const doc = [
      "| Name | Example |",
      "| --- | --- |",
      "| A | escaped \\| pipe |",
    ].join("\n");
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("pipe") },
    });

    const context = getMarkdownTableContext(state);

    expect(context?.currentRow).toBe(2);
    expect(context?.currentColumn).toBe(1);
    expect(context?.currentCell.text).toBe("escaped \\| pipe");
    expect(context?.columnCount).toBe(2);
  });

  it("pads ragged rows when inserting a column", () => {
    const doc = [
      "| A | B |",
      "| --- | --- |",
      "| one |",
      "| two | escaped \\| pipe | extra |",
    ].join("\n");
    const view = createView(doc, "one");

    expect(insertMarkdownTableColumn(view, "right")).toBe(true);

    expect(view.state.doc.toString()).toBe(
      [
        "| A |  | B |  |",
        "| --- | --- | --- | --- |",
        "| one |  |  |  |",
        "| two |  | escaped \\| pipe | extra |",
      ].join("\n"),
    );
    view.destroy();
  });

  it("reads and rewrites alignment markers for the active column", () => {
    const doc = [
      "| A | B | C |",
      "| :--- | :---: | ---: |",
      "| 1 | 2 | 3 |",
    ].join("\n");
    const view = createView(doc, "2");

    expect(getMarkdownTableContext(view.state)?.alignments).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect(setMarkdownTableColumnAlignment(view, "none")).toBe(true);

    expect(view.state.doc.toString()).toBe(
      ["| A | B | C |", "| :--- | --- | ---: |", "| 1 | 2 | 3 |"].join("\n"),
    );
    view.destroy();
  });

  it("uses the configured CRLF line separator when dispatching table rewrites", () => {
    const normalizedDoc = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const doc = normalizedDoc.replaceAll("\n", "\r\n");
    const state = EditorState.create({
      doc,
      extensions: [EditorState.lineSeparator.of("\r\n")],
      selection: { anchor: normalizedDoc.indexOf("1") },
    });
    const dispatch = vi.fn();
    const view = { dispatch, state } as unknown as EditorView;

    expect(tidyMarkdownTable(view)).toBe(true);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].changes.insert).toBe(
      ["| A   | B   |", "| --- | --- |", "| 1   | 2   |"].join("\r\n"),
    );
  });

  it("appends a new row when Tab moves past the last table cell", () => {
    const doc = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const view = createView(doc, "2");

    expect(moveMarkdownTableCell(view, 1)).toBe(true);

    expect(view.state.doc.toString()).toBe(
      ["| A | B |", "| --- | --- |", "| 1 | 2 |", "|  |  |"].join("\n"),
    );
    const context = getMarkdownTableContext(view.state);
    expect(context?.currentRow).toBe(3);
    expect(context?.currentColumn).toBe(0);
    expect(view.state.selection.main.empty).toBe(true);
    view.destroy();
  });
});
