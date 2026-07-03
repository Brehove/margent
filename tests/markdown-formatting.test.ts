import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { runMarkdownFormattingCommand } from "../src/components/editor/markdownFormatting";

function createView(doc: string, from: number, to = from) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: {
        anchor: from,
        head: to,
      },
    }),
  });
}

describe("markdown formatting commands", () => {
  it("turns a partial text selection into a bullet list item", () => {
    const doc = "This is selected text";
    const view = createView(doc, 0, "This".length);

    expect(runMarkdownFormattingCommand(view, "bullet-list")).toBe(true);

    expect(view.state.doc.toString()).toBe("- This is selected text");
    view.destroy();
  });

  it("turns typed heading markers into a heading line", () => {
    const doc = "Heading";
    const view = createView(doc, 0, doc.length);

    expect(runMarkdownFormattingCommand(view, "heading-2")).toBe(true);

    expect(view.state.doc.toString()).toBe("## Heading");
    view.destroy();
  });
});
