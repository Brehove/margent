import { describe, expect, it } from "vitest";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import {
  buildMarkdownFootnoteDefinitionReplacement,
  buildMarkdownImageBlockInsertion,
  buildMarkdownLinkReplacement,
  buildFocusModeDecorations,
  buildReadableMarkdownDecorations,
  buildRenderedMarkdownDecorations,
  classifyReadableMarkdownLine,
  convertClipboardHtmlToMarkdown,
  editorCompositionStateField,
  importImageFileAtSelection,
  pendingImageInsertionRangeField,
  readActiveFootnoteDefinition,
  readActiveMarkdownLink,
  toggleMarkdownInlineStyle,
} from "../src/components/editor/useCodeMirror";

function getWidgetName(widget: unknown) {
  return widget && typeof widget === "object"
    ? (widget as { constructor: { name: string } }).constructor.name
    : "";
}

describe("classifyReadableMarkdownLine", () => {
  it("classifies headings by level", () => {
    expect(classifyReadableMarkdownLine("## Heading")).toEqual([
      "cm-md-line",
      "cm-md-heading",
      "cm-md-h2",
    ]);
  });

  it("classifies blockquotes", () => {
    expect(classifyReadableMarkdownLine("> quoted paragraph")).toEqual([
      "cm-md-line",
      "cm-md-blockquote",
    ]);
  });

  it("classifies bullet lists", () => {
    expect(classifyReadableMarkdownLine("- item")).toEqual([
      "cm-md-line",
      "cm-md-list",
    ]);
  });

  it("classifies ordered lists", () => {
    expect(classifyReadableMarkdownLine("1. item")).toEqual([
      "cm-md-line",
      "cm-md-list",
      "cm-md-list-ordered",
    ]);
  });

  it("classifies thematic breaks", () => {
    expect(classifyReadableMarkdownLine("---")).toEqual([
      "cm-md-line",
      "cm-md-hr",
    ]);
  });

  it("leaves plain paragraphs undecorated", () => {
    expect(classifyReadableMarkdownLine("Plain paragraph text.")).toEqual([]);
  });
});

describe("buildReadableMarkdownDecorations", () => {
  it("adds line decorations for visible markdown structure only", () => {
    const state = EditorState.create({
      doc: ["# Title", "", "> Quote", "- Item", "Body"].join("\n"),
    });
    const decorations = buildReadableMarkdownDecorations(state, [
      {
        from: 0,
        to: state.doc.length,
      },
    ]);

    const classesByLine = new Map<number, string>();
    decorations.between(0, state.doc.length, (from, _to, decoration) => {
      const className = decoration.spec.attributes?.class;
      if (!className) {
        return;
      }

      classesByLine.set(state.doc.lineAt(from).number, className);
    });

    expect(classesByLine.get(1)).toContain("cm-md-heading");
    expect(classesByLine.get(3)).toContain("cm-md-blockquote");
    expect(classesByLine.get(4)).toContain("cm-md-list");
    expect(classesByLine.has(5)).toBe(false);
  });

  it("respects visible ranges instead of decorating the whole document", () => {
    const state = EditorState.create({
      doc: ["# Title", "Body", "> Quote"].join("\n"),
    });
    const titleLine = state.doc.line(1);
    const bodyLine = state.doc.line(2);
    const decorations = buildReadableMarkdownDecorations(state, [
      {
        from: bodyLine.from,
        to: bodyLine.to,
      },
    ]);

    const decoratedLines: number[] = [];
    decorations.between(0, state.doc.length, (from) => {
      decoratedLines.push(state.doc.lineAt(from).number);
    });

    expect(decoratedLines).not.toContain(titleLine.number);
    expect(decoratedLines).toEqual([]);
  });
});

describe("buildFocusModeDecorations", () => {
  it("dims visible non-active blocks when focus mode is enabled", () => {
    const doc = ["First paragraph.", "", "Second paragraph."].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("First"),
      },
    });

    const decorations = buildFocusModeDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      true,
    );

    const dimmedTexts: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-focus-dimmed-block") {
        dimmedTexts.push(state.doc.sliceString(from, to));
      }
    });

    expect(dimmedTexts).toEqual(["Second paragraph."]);
  });

  it("keeps the active block full strength", () => {
    const doc = ["First paragraph.", "", "Second paragraph."].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Second"),
      },
    });

    const decorations = buildFocusModeDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      true,
    );

    const dimmedTexts: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-focus-dimmed-block") {
        dimmedTexts.push(state.doc.sliceString(from, to));
      }
    });

    expect(dimmedTexts).toEqual(["First paragraph."]);
  });

  it("emits no dimming decorations when disabled", () => {
    const state = EditorState.create({
      doc: ["First paragraph.", "Second paragraph."].join("\n"),
      extensions: [markdown()],
    });

    const decorations = buildFocusModeDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      false,
    );

    let decorationCount = 0;
    decorations.between(0, state.doc.length, () => {
      decorationCount += 1;
    });

    expect(decorationCount).toBe(0);
  });
});

describe("buildRenderedMarkdownDecorations", () => {
  it("hides markdown delimiters on inactive lines in rendered mode", () => {
    const state = EditorState.create({
      doc: ["# Heading", "Paragraph with *em* and `code` and [label](https://x.test)"].join("\n"),
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [
        {
          from: 0,
          to: state.doc.length,
        },
      ],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class !== "cm-md-syntax-hidden") {
        return;
      }

      hiddenRanges.push(state.doc.sliceString(from, to));
    });

    expect(hiddenRanges).toContain("*");
    expect(hiddenRanges).toContain("`");
    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("]");
    expect(hiddenRanges).toContain("(");
    expect(hiddenRanges).toContain(")");
    expect(hiddenRanges).toContain("https://x.test");
  });

  it("adds explicit rendered styling ranges for italic, bold, and bold-italic text", () => {
    const doc = "Paragraph with *italic*, **bold**, and ***both***.";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const styledRanges: Array<{ className: string; text: string }> = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (
        decoration.spec.class !== "cm-md-emphasis-content" &&
        decoration.spec.class !== "cm-md-strong-content"
      ) {
        return;
      }

      styledRanges.push({
        className: decoration.spec.class,
        text: state.doc.sliceString(from, to),
      });
    });

    expect(styledRanges).toContainEqual({
      className: "cm-md-emphasis-content",
      text: "italic",
    });
    expect(styledRanges).toContainEqual({
      className: "cm-md-strong-content",
      text: "bold",
    });
    expect(styledRanges).toContainEqual({
      className: "cm-md-emphasis-content",
      text: "**both**",
    });
    expect(styledRanges).toContainEqual({
      className: "cm-md-strong-content",
      text: "both",
    });
  });

  it("also hides link titles on inactive lines in rendered mode", () => {
    const doc = ['# Heading', 'Paragraph with [label](https://x.test "Title")'].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain('"Title"');
  });

  it("hides angle-wrapped local link paths with spaces in rendered mode", () => {
    const doc = [
      "# Heading",
      "Shared resource: [Agent-Native Product Management and Higher Ed](</Users/example/Documents/Notes Archive/Work/Talks/Shared Resources/agent-native-product-management-and-higher-ed.md>)",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("(");
    expect(hiddenRanges).toContain(
      "</Users/example/Documents/Notes Archive/Work/Talks/Shared Resources/agent-native-product-management-and-higher-ed.md>",
    );
    expect(hiddenRanges).toContain(")");
  });

  it("hides loose local link paths with spaces even when they are not angle-wrapped", () => {
    const doc =
      "Local student/research example: [Sample Research RAG Example](/Users/example/Documents/Notes Archive/Work/Talks/2026/2026-05-14 - BSU AI Institute - Mini-Plenary/resources/samuel-deluna-rag-open-research-example.md).";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Sample"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const styledRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.class === "cm-md-loose-local-link-label") {
        styledRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("](");
    expect(hiddenRanges).toContain(
      "/Users/example/Documents/Notes Archive/Work/Talks/2026/2026-05-14 - BSU AI Institute - Mini-Plenary/resources/samuel-deluna-rag-open-research-example.md",
    );
    expect(hiddenRanges).toContain(")");
    expect(styledRanges).toContain("Sample Research RAG Example");
  });

  it("renders inactive Obsidian wikilinks as inert local link labels", () => {
    const doc = "See [[Project Note|the note]] and [[Plain Note]].\n\nTrailing";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Trailing"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const styledRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.class === "cm-md-wikilink-label") {
        styledRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[[Project Note|");
    expect(hiddenRanges).toContain("[[");
    expect(hiddenRanges).toContain("]]");
    expect(styledRanges).toContain("the note");
    expect(styledRanges).toContain("Plain Note");
  });

  it("keeps Obsidian embeds raw in rendered mode", () => {
    const doc = "![[image.png]]\n\nTrailing";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Trailing"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const styledRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.class === "cm-md-wikilink-label") {
        styledRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).not.toContain("[[");
    expect(hiddenRanges).not.toContain("]]");
    expect(styledRanges).toEqual([]);
  });

  it("keeps wikilink source hidden while its paragraph is active", () => {
    const doc = "See [[Project Note|the note]] here.\n\nTrailing";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("the note"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const styledRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.class === "cm-md-wikilink-label") {
        styledRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[[Project Note|");
    expect(styledRanges).toContain("the note");
  });

  it("styles document-opening YAML frontmatter as metadata lines", () => {
    const doc = ["---", "title: Test", "tags:", "  - margent", "---", "", "# Body"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("# Body"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const lineClasses = new Map<number, string[]>();
    decorations.between(0, state.doc.length, (from, _to, decoration) => {
      if (!decoration.spec.attributes?.class) {
        return;
      }
      const lineNumber = state.doc.lineAt(from).number;
      lineClasses.set(lineNumber, [
        ...(lineClasses.get(lineNumber) ?? []),
        decoration.spec.attributes.class,
      ]);
    });

    expect(
      lineClasses.get(1)?.some((className) => className.includes("cm-md-frontmatter-start")),
    ).toBe(true);
    expect(
      lineClasses.get(2)?.some((className) => className.includes("cm-md-frontmatter-content")),
    ).toBe(true);
    expect(
      lineClasses.get(5)?.some((className) => className.includes("cm-md-frontmatter-end")),
    ).toBe(true);
  });

  it("does not style later thematic breaks as frontmatter", () => {
    const doc = ["Intro", "", "---", "", "Trailing"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Trailing"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const classNames: string[] = [];
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.attributes?.class) {
        classNames.push(decoration.spec.attributes.class);
      }
    });

    expect(classNames.some((className) => className.includes("cm-md-frontmatter"))).toBe(false);
    expect(classNames.some((className) => className.includes("cm-md-hr"))).toBe(true);
  });

  it("renders inactive task list markers as checkbox widgets", () => {
    const doc = ["# Tasks", "", "- [ ] todo", "- [x] done"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );
    const hiddenRanges: string[] = [];
    const widgets: unknown[] = [];

    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.widget) {
        widgets.push(decoration.spec.widget);
      }
    });

    expect(hiddenRanges).toContain("[ ]");
    expect(hiddenRanges).toContain("[x]");
    expect(widgets.filter((widget) => getWidgetName(widget) === "TaskCheckboxWidget")).toHaveLength(2);
    expect(widgets.filter((widget) => getWidgetName(widget) === "MarkdownMarkerWidget")).toHaveLength(0);
  });

  it("toggles rendered task checkbox widgets by editing the markdown marker", () => {
    const state = EditorState.create({
      doc: "# Tasks\n\n- [ ] todo\n",
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });
    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );
    let taskWidget: { toDOM: (view: EditorView) => HTMLElement } | null = null;
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (getWidgetName(decoration.spec.widget) === "TaskCheckboxWidget") {
        taskWidget = decoration.spec.widget as { toDOM: (view: EditorView) => HTMLElement };
      }
    });

    expect(taskWidget).not.toBeNull();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state,
    });
    const checkbox = taskWidget!.toDOM(view);
    checkbox.click();

    expect(view.state.doc.toString()).toBe("# Tasks\n\n- [x] todo\n");

    view.destroy();
    host.remove();
  });

  it("keeps task list markers rendered on the active list item", () => {
    const doc = "# Tasks\n\n- [ ] todo\n";
    const taskLineStart = doc.indexOf("[ ]");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: taskLineStart + 1,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );
    const hiddenRanges: string[] = [];
    const widgets: unknown[] = [];

    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.widget) {
        widgets.push(decoration.spec.widget);
      }
    });

    expect(hiddenRanges).toContain("[ ]");
    expect(widgets.filter((widget) => getWidgetName(widget) === "TaskCheckboxWidget")).toHaveLength(1);
  });

  it("keeps inline markdown syntax hidden on the active line in rendered mode", () => {
    const doc = "Paragraph with *em* and [label](https://x.test)";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("*em*") + 1,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [
        {
          from: 0,
          to: state.doc.length,
        },
      ],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("*");
    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("https://x.test");
  });

  it("keeps active paragraph inline syntax rendered in rendered mode", () => {
    const doc = [
      "Paragraph with [label](https://x.test)",
      "continued on the next line",
      "",
      "Separate paragraph with *emphasis*",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("continued"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [
        {
          from: 0,
          to: state.doc.length,
        },
      ],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("https://x.test");
    expect(hiddenRanges).toContain("*");
  });

  it("keeps active list item inline syntax rendered in rendered mode", () => {
    const doc = ["- first [label](https://x.test)", "- second *emphasis*"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("first"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [
        {
          from: 0,
          to: state.doc.length,
        },
      ],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("https://x.test");
    expect(hiddenRanges).toContain("*");
  });

  it("renders visible bullet markers for inactive list items", () => {
    const doc = ["- bullet item", "- another bullet", "Trailing paragraph"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Trailing"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const widgetTexts: string[] = [];
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      const widget = decoration.spec.widget;
      if (!widget) {
        return;
      }

      widgetTexts.push(widget.toDOM().textContent ?? "");
    });

    expect(widgetTexts).toContain("•");
  });

  it("keeps link syntax hidden while a rendered-mode link is active", () => {
    const doc = "Paragraph with [label](https://x.test) and *emphasis*";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("label") + 2,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("https://x.test");
    expect(hiddenRanges).toContain("*");
  });

  it("renders inactive fenced code blocks as code panels", () => {
    const doc = [
      "```js",
      "const x = 1",
      "```",
      "",
      "Paragraph with `code`",
      "",
      "Trailing",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Trailing"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [
        {
          from: 0,
          to: state.doc.length,
        },
      ],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const lineClasses = new Map<number, string[]>();
    const widgetTexts: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.attributes?.class) {
        const lineNumber = state.doc.lineAt(from).number;
        lineClasses.set(lineNumber, [
          ...(lineClasses.get(lineNumber) ?? []),
          decoration.spec.attributes.class,
        ]);
      }
      if (getWidgetName(decoration.spec.widget) === "CodeBlockLanguageWidget") {
        widgetTexts.push(decoration.spec.widget.toDOM().textContent ?? "");
      }
    });

    expect(hiddenRanges).toContain("```js");
    expect(hiddenRanges).toContain("```");
    expect(hiddenRanges).toContain("`");
    expect(widgetTexts).toContain("js");
    expect(
      lineClasses.get(1)?.some((className) => className.includes("cm-md-code-block-start")),
    ).toBe(true);
    expect(
      lineClasses.get(2)?.some((className) => className.includes("cm-md-code-block-content")),
    ).toBe(true);
    expect(
      lineClasses.get(3)?.some((className) => className.includes("cm-md-code-block-end")),
    ).toBe(true);
  });

  it("keeps fenced code block chrome rendered while the caret is inside content", () => {
    const doc = ["```ts", "const x = 1", "```", "", "Trailing"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("const"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [
        {
          from: 0,
          to: state.doc.length,
        },
      ],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const widgets: unknown[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.widget) {
        widgets.push(decoration.spec.widget);
      }
    });

    expect(hiddenRanges).toContain("```ts");
    expect(hiddenRanges).toContain("```");
    expect(
      widgets.filter((widget) => getWidgetName(widget) === "CodeBlockLanguageWidget"),
    ).toHaveLength(1);
  });

  it("keeps active markdown tables in rendered preview form", () => {
    const doc = ["| name | link |", "| --- | --- |", "| item | [label](https://x.test) |"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: 0 },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const widgets: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.widget) {
        widgets.push(getWidgetName(decoration.spec.widget));
      }
    });

    expect(hiddenRanges).toContain(doc);
    expect(hiddenRanges.join("")).toContain("https://x.test");
    expect(widgets).toContain("MarkdownTablePreviewWidget");
    expect(widgets).not.toContain("MarkdownTableBlockWidget");
  });

  it("renders inactive markdown tables as bounded preview widgets", () => {
    const doc = [
      "| name | link |",
      "| --- | --- |",
      "| item | [label](https://x.test) |",
      "",
      "Trailing",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: doc.indexOf("Trailing") },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const widgets: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.widget) {
        widgets.push(getWidgetName(decoration.spec.widget));
      }
    });

    expect(widgets).toContain("MarkdownTablePreviewWidget");
    expect(widgets).not.toContain("MarkdownTableBlockWidget");
  });

  it("keeps a source-styled fallback when the viewport starts mid-table", () => {
    const doc = [
      "Intro paragraph",
      "| name | link |",
      "| --- | --- |",
      "| item | [label](https://x.test) |",
      "Outro paragraph",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: doc.indexOf("Outro") },
    });

    const bodyLine = state.doc.line(4);
    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: bodyLine.from, to: bodyLine.to }],
      "rendered",
    );

    const lineClasses: string[] = [];
    const widgets: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (from === to && typeof decoration.spec.attributes?.class === "string") {
        lineClasses.push(decoration.spec.attributes.class);
      }
      if (decoration.spec.widget) {
        widgets.push(getWidgetName(decoration.spec.widget));
      }
    });

    expect(lineClasses.some((className) => className.includes("cm-md-table-line"))).toBe(true);
    expect(widgets).not.toContain("MarkdownTableBlockWidget");
  });

  it("renders long-draft table passages as bounded preview widgets", () => {
    const doc = [
      "Use this table as a map.",
      "",
      "| Tool family | What it can help with | What to check |",
      "|---|---|---|",
      "| General chatbot | explanations, examples, brainstorming, practice questions | accuracy, fit, source absence, overconfidence |",
      "| Assistive AI | captions, dictation, speech-to-text, text-to-speech, read-aloud, transcript review | accuracy, permissions, whether the support keeps you active |",
      "",
      "NotebookLM is a useful example.",
      "",
      "## Source-Grounded Still Needs Checking",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: doc.indexOf("Source-Grounded") },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const widgets: string[] = [];
    decorations.between(0, state.doc.length, (from, _to, decoration) => {
      if (decoration.spec.widget) {
        widgets.push(getWidgetName(decoration.spec.widget));
      }
    });

    expect(widgets).toContain("MarkdownTablePreviewWidget");
    expect(widgets).not.toContain("MarkdownTableBlockWidget");
  });

  it("does not treat plain prose with a single pipe as a markdown table header", () => {
    const doc = [
      "Prose a | b line",
      "| --- | --- |",
      "Paragraph with [label](https://x.test)",
      "",
      "Trailing paragraph",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: doc.indexOf("Trailing") },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("https://x.test");
  });

  it("keeps inline html in raw/source fallback form", () => {
    const doc = "Text before <span>[label](https://x.test)</span> after";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: 0 },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).not.toContain("[");
    expect(hiddenRanges).not.toContain("https://x.test");
  });

  it("scopes inline html fallback to the html span instead of the whole paragraph", () => {
    const doc = ["Prefix <span>inline</span> [label](https://x.test)", "", "Trailing paragraph"].join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: doc.indexOf("Trailing") },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("https://x.test");
    expect(hiddenRanges).not.toContain("<span>");
  });

  it("renders standalone images as block widgets in rendered mode", () => {
    const doc = '![alt](https://x.test/image.png "caption")\n\nTrailing';
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: doc.indexOf("Trailing") },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const widgets: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.widget) {
        widgets.push(getWidgetName(decoration.spec.widget));
      }
    });

    expect(widgets).toEqual(["MarkdownImageBlockWidget"]);
  });

  it("keeps inline images in raw/source fallback form", () => {
    const doc = 'Image here ![alt](https://x.test/image.png "caption") inline.';
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: { anchor: 0 },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    const widgets: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
      if (decoration.spec.widget) {
        widgets.push(getWidgetName(decoration.spec.widget));
      }
    });

    expect(hiddenRanges).not.toContain("![");
    expect(hiddenRanges).not.toContain("https://x.test/image.png");
    expect(hiddenRanges).not.toContain('"caption"');
    expect(widgets).not.toContain("MarkdownImageBlockWidget");
  });

  it("renders inactive footnote references as superscript labels", () => {
    const doc = ["# Heading", "Paragraph with footnote[^alpha] text.", "", "[^alpha]: Definition"].join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const footnoteReferenceRanges: Array<{ from: number; to: number }> = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-footnote-ref") {
        footnoteReferenceRanges.push({ from, to });
      }
    });

    expect(footnoteReferenceRanges).toEqual([
      {
        from: doc.indexOf("alpha"),
        to: doc.indexOf("alpha") + "alpha".length,
      },
    ]);
  });

  it("keeps the surrounding footnote brackets hidden in rendered mode", () => {
    const doc = ["# Heading", "Paragraph with footnote[^alpha].", "", "[^alpha]: Definition"].join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[");
    expect(hiddenRanges).toContain("]");
    expect(hiddenRanges).toContain("^");
  });

  it("reveals the active footnote reference token instead of the whole block", () => {
    const doc = ["Paragraph with footnote[^alpha] and *emphasis*.", "", "[^alpha]: Definition"].join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("^alpha") + 2,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    let footnoteReferenceCount = 0;
    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-footnote-ref") {
        footnoteReferenceCount += 1;
      }

      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(footnoteReferenceCount).toBe(0);
    expect(hiddenRanges).not.toContain("[");
    expect(hiddenRanges).toContain("*");
  });

  it("renders inactive footnote definitions without their definition marker", () => {
    const doc = ["# Heading", "Body[^1]", "", "[^1]:   Footnote definition"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[^1]:   ");
  });

  it("hides continuation indentation for inactive footnote definitions", () => {
    const doc = ["# Heading", "Body[^1]", "", "[^1]: First line", "    continuation line"].join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("    ");
  });

  it("reveals the whole active footnote definition block", () => {
    const doc = ["# Heading", "Body[^1]", "", "[^1]: First line", "    continuation line"].join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("First line") + 2,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).not.toContain("[^1]: ");
    expect(hiddenRanges).not.toContain("    ");
  });

  it("keeps footnote definition syntax hidden from the definition marker boundary", () => {
    const doc = ["# Heading", "Body[^1]", "", "[^1]: First line", "    continuation line"].join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("[^1]:"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const hiddenRanges: string[] = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenRanges.push(state.doc.sliceString(from, to));
      }
    });

    expect(hiddenRanges).toContain("[^1]: ");
    expect(hiddenRanges).toContain("    ");
  });

  it("does not style footnote-like literals inside inline code or fenced code", () => {
    const doc = [
      "# Heading",
      "Inline `[^alpha]` example",
      "",
      "```md",
      "[^beta]",
      "```",
      "",
      "Real footnote[^gamma]",
      "",
      "[^gamma]: Definition",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const footnoteReferenceRanges: Array<{ from: number; to: number }> = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-footnote-ref") {
        footnoteReferenceRanges.push({ from, to });
      }
    });

    expect(footnoteReferenceRanges).toEqual([
      {
        from: doc.indexOf("gamma"),
        to: doc.indexOf("gamma") + "gamma".length,
      },
    ]);
  });

  it("does not render footnote-like literals without a matching definition", () => {
    const doc = ["# Heading", "Literal example [^alpha] without a definition"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    let footnoteReferenceCount = 0;
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.class === "cm-md-footnote-ref") {
        footnoteReferenceCount += 1;
      }
    });

    expect(footnoteReferenceCount).toBe(0);
  });

  it("does not render standalone literal examples even when a matching definition exists elsewhere", () => {
    const doc = [
      "# Heading",
      "Literal example [^alpha] in prose.",
      "",
      "Real footnote[^alpha]",
      "",
      "[^alpha]: Definition",
    ].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    const footnoteReferenceRanges: Array<{ from: number; to: number }> = [];
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-md-footnote-ref") {
        footnoteReferenceRanges.push({ from, to });
      }
    });

    expect(footnoteReferenceRanges).toEqual([
      {
        from: doc.indexOf("alpha", doc.indexOf("Real footnote")),
        to: doc.indexOf("alpha", doc.indexOf("Real footnote")) + "alpha".length,
      },
    ]);
  });

  it("does not hide syntax in raw mode", () => {
    const doc = "# Heading\nParagraph with *em* and [label](https://x.test)";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: 0,
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [
        {
          from: 0,
          to: state.doc.length,
        },
      ],
      "raw",
    );

    let decorationCount = 0;
    let hiddenDecorationCount = 0;
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      decorationCount += 1;
      if (decoration.spec.class === "cm-md-syntax-hidden") {
        hiddenDecorationCount += 1;
      }
    });

    expect(decorationCount).toBe(0);
    expect(hiddenDecorationCount).toBe(0);
  });

  it("pauses rendered projection while composition is active", () => {
    const doc = "# Heading\nParagraph with *em* and [label](https://x.test)";
    const state = EditorState.create({
      doc,
      extensions: [markdown(), editorCompositionStateField.init(() => true)],
      selection: {
        anchor: doc.indexOf("Paragraph"),
      },
    });

    const decorations = buildRenderedMarkdownDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      "rendered",
    );

    let decorationCount = 0;
    decorations.between(0, state.doc.length, () => {
      decorationCount += 1;
    });

    expect(decorationCount).toBe(0);
  });
});

describe("readActiveMarkdownLink", () => {
  it("returns the active link under the caret", () => {
    const doc = 'Paragraph [label text](https://x.test "Title") more';
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("label text") + 3,
      },
    });

    expect(readActiveMarkdownLink(state)).toEqual({
      from: doc.indexOf("[label text]"),
      label: "label text",
      labelFrom: doc.indexOf("label text"),
      labelTo: doc.indexOf("label text") + "label text".length,
      title: "Title",
      titleFrom: doc.indexOf('"Title"'),
      titleTo: doc.indexOf('"Title"') + '"Title"'.length,
      to: doc.indexOf(') more') + 1,
      url: "https://x.test",
      urlFrom: doc.indexOf("https://x.test"),
      urlTo: doc.indexOf("https://x.test") + "https://x.test".length,
    });
  });

  it("returns null when the selection extends outside a single link", () => {
    const doc = "Start [label](https://x.test) finish";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Start"),
        head: doc.indexOf("finish") + 2,
      },
    });

    expect(readActiveMarkdownLink(state)).toBeNull();
  });

  it("returns active links with angle-wrapped local paths containing spaces", () => {
    const doc =
      "Key research note: [Course as Agent-Native System](</Users/example/Documents/Notes Archive/Work/Talks/2026/course-as-agent-native-research.md>).";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Agent-Native") + 2,
      },
    });

    expect(readActiveMarkdownLink(state)).toMatchObject({
      label: "Course as Agent-Native System",
      url: "</Users/example/Documents/Notes Archive/Work/Talks/2026/course-as-agent-native-research.md>",
    });
  });

  it("returns active links for loose local paths with spaces", () => {
    const doc =
      "Local example: [Sample Research RAG Example](/Users/example/Documents/Notes Archive/Work/Talks/2026/2026-05-14 - BSU AI Institute - Mini-Plenary/resources/samuel-deluna-rag-open-research-example.md).";
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Sample"),
      },
    });

    expect(readActiveMarkdownLink(state)).toMatchObject({
      label: "Sample Research RAG Example",
      url: "/Users/example/Documents/Notes Archive/Work/Talks/2026/2026-05-14 - BSU AI Institute - Mini-Plenary/resources/samuel-deluna-rag-open-research-example.md",
    });
  });
});

describe("buildMarkdownLinkReplacement", () => {
  it("omits the title segment when it is blank", () => {
    expect(
      buildMarkdownLinkReplacement({
        label: "label",
        title: "   ",
        url: "https://x.test",
      }),
    ).toBe("[label](https://x.test)");
  });

  it("angle-wraps URLs that contain spaces", () => {
    expect(
      buildMarkdownLinkReplacement({
        label: "label",
        title: null,
        url: "/Users/example/Documents/Notes Archive/example.md",
      }),
    ).toBe("[label](</Users/example/Documents/Notes Archive/example.md>)");
  });
});

describe("toggleMarkdownInlineStyle", () => {
  it("wraps selected text in strong markdown for Cmd+B behavior", () => {
    const parent = document.createElement("div");
    const doc = "Make this bold";
    const view = new EditorView({
      doc,
      extensions: [markdown()],
      parent,
      selection: {
        anchor: doc.indexOf("this"),
        head: doc.indexOf("this") + "this".length,
      },
    });

    toggleMarkdownInlineStyle(view, "**");

    expect(view.state.doc.toString()).toBe("Make **this** bold");
    view.destroy();
  });

  it("unwraps selected strong markdown when the style is already present", () => {
    const parent = document.createElement("div");
    const doc = "Make **this** bold";
    const view = new EditorView({
      doc,
      extensions: [markdown()],
      parent,
      selection: {
        anchor: doc.indexOf("this"),
        head: doc.indexOf("this") + "this".length,
      },
    });

    toggleMarkdownInlineStyle(view, "**");

    expect(view.state.doc.toString()).toBe("Make this bold");
    view.destroy();
  });

  it("inserts paired italic markers at an empty selection", () => {
    const parent = document.createElement("div");
    const doc = "Write here";
    const view = new EditorView({
      doc,
      extensions: [markdown()],
      parent,
      selection: {
        anchor: doc.indexOf("here"),
      },
    });

    toggleMarkdownInlineStyle(view, "*");

    expect(view.state.doc.toString()).toBe("Write **here");
    expect(view.state.selection.main.from).toBe(doc.indexOf("here") + 1);
    view.destroy();
  });

  it("wraps selected text in italic markdown for Cmd+I behavior", () => {
    const parent = document.createElement("div");
    const doc = "Make this italic";
    const view = new EditorView({
      doc,
      extensions: [markdown()],
      parent,
      selection: {
        anchor: doc.indexOf("this"),
        head: doc.indexOf("this") + "this".length,
      },
    });

    toggleMarkdownInlineStyle(view, "*");

    expect(view.state.doc.toString()).toBe("Make *this* italic");
    view.destroy();
  });

  it("adds italic to bold text without removing the bold formatting", () => {
    const parent = document.createElement("div");
    const doc = "Make **this** styled";
    const view = new EditorView({
      doc,
      extensions: [markdown()],
      parent,
      selection: {
        anchor: doc.indexOf("this"),
        head: doc.indexOf("this") + "this".length,
      },
    });

    toggleMarkdownInlineStyle(view, "*");

    expect(view.state.doc.toString()).toBe("Make ***this*** styled");

    toggleMarkdownInlineStyle(view, "*");

    expect(view.state.doc.toString()).toBe("Make **this** styled");
    view.destroy();
  });

  it("adds bold to italic text without removing the italic formatting", () => {
    const parent = document.createElement("div");
    const doc = "Make *this* styled";
    const view = new EditorView({
      doc,
      extensions: [markdown()],
      parent,
      selection: {
        anchor: doc.indexOf("this"),
        head: doc.indexOf("this") + "this".length,
      },
    });

    toggleMarkdownInlineStyle(view, "**");

    expect(view.state.doc.toString()).toBe("Make ***this*** styled");

    toggleMarkdownInlineStyle(view, "**");

    expect(view.state.doc.toString()).toBe("Make *this* styled");
    view.destroy();
  });

  it("lets Cmd+I formatting override CodeMirror's default syntax-parent shortcut", () => {
    const parent = document.createElement("div");
    const doc = "Make this italic";
    const view = new EditorView({
      doc,
      extensions: [
        markdown(),
        keymap.of(defaultKeymap),
        Prec.highest(
          keymap.of([
            {
              key: "Mod-i",
              preventDefault: true,
              run(currentView) {
                return toggleMarkdownInlineStyle(currentView, "*");
              },
            },
          ]),
        ),
      ],
      parent,
      selection: {
        anchor: doc.indexOf("this"),
        head: doc.indexOf("this") + "this".length,
      },
    });

    const handled = runScopeHandlers(
      view,
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyI",
        key: "i",
        keyCode: 73,
        ctrlKey: true,
      }),
      "editor",
    );

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe("Make *this* italic");
    view.destroy();
  });
});

describe("convertClipboardHtmlToMarkdown", () => {
  it("preserves basic formatting and links from HTML paste payloads", async () => {
    expect(
      await convertClipboardHtmlToMarkdown(
        '<h2>Heading</h2><p>Text with <strong>bold</strong> and <a href="https://x.test">link</a>.</p>',
      ),
    ).toBe("## Heading\n\nText with **bold** and [link](https://x.test).");
  });

  it("falls back to plain text when the HTML payload has no usable content", async () => {
    await expect(convertClipboardHtmlToMarkdown("<br>", "fallback text")).resolves.toBe(
      "fallback text",
    );
  });
});

describe("buildMarkdownImageBlockInsertion", () => {
  it("pads pasted images onto block boundaries", () => {
    const state = EditorState.create({ doc: "Intro paragraph\nNext paragraph" });
    const insertion = buildMarkdownImageBlockInsertion(
      state,
      "Intro paragraph".length,
      "Intro paragraph".length,
      "assets/screenshot.png",
      "Screen Shot.png",
    );

    expect(insertion.insert).toBe("\n\n![Screen Shot](assets/screenshot.png)\n");
  });

  it("escapes bracket characters in generated alt text", () => {
    const state = EditorState.create({ doc: "" });
    const insertion = buildMarkdownImageBlockInsertion(
      state,
      0,
      0,
      "assets/image.png",
      "before[after].png",
    );

    expect(insertion.insert).toBe("![before\\[after\\]](assets/image.png)");
  });

  it("maps delayed image imports through edits made while the import is pending", async () => {
    let resolveImport: (path: string) => void = () => {};
    const importImageAsset = () =>
      new Promise<string>((resolve) => {
        resolveImport = resolve;
      });
    const view = new EditorView({
      state: EditorState.create({
        doc: "Hello",
        extensions: [pendingImageInsertionRangeField],
        selection: {
          anchor: "Hello".length,
        },
      }),
    });
    const file = new File(["image-bytes"], "shot.png", {
      type: "image/png",
    });

    const importPromise = importImageFileAtSelection(view, file, importImageAsset);
    view.dispatch({
      changes: {
        from: "Hello".length,
        insert: " world",
      },
    });
    resolveImport("assets/shot.png");
    await importPromise;

    expect(view.state.doc.toString()).toBe("Hello world\n\n![shot](assets/shot.png)");
    view.destroy();
  });
});

describe("readActiveFootnoteDefinition", () => {
  it("returns the active footnote definition with normalized continuation content", () => {
    const doc = ["Paragraph[^note]", "", "[^note]: First line", "    continuation line"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("First line") + 3,
      },
    });

    expect(readActiveFootnoteDefinition(state)).toEqual({
      blockContent: "[^note]: First line\n    continuation line",
      content: "First line\ncontinuation line",
      from: doc.indexOf("[^note]:"),
      label: "note",
      to: doc.length,
      tokenFrom: doc.indexOf("[^note]:"),
      tokenTo: doc.indexOf("[^note]:") + "[^note]:".length,
    });
  });

  it("returns null when the selection is outside a footnote definition block", () => {
    const doc = ["Paragraph[^note]", "", "[^note]: First line"].join("\n");
    const state = EditorState.create({
      doc,
      extensions: [markdown()],
      selection: {
        anchor: doc.indexOf("Paragraph") + 2,
      },
    });

    expect(readActiveFootnoteDefinition(state)).toBeNull();
  });
});

describe("buildMarkdownFootnoteDefinitionReplacement", () => {
  it("formats multiline footnote definitions with markdown continuation indentation", () => {
    expect(
      buildMarkdownFootnoteDefinitionReplacement({
        content: "First line\nSecond line\n",
        label: "note",
      }),
    ).toBe("[^note]: First line\n    Second line\n    ");
  });

  it("trims the label while preserving an empty first content line", () => {
    expect(
      buildMarkdownFootnoteDefinitionReplacement({
        content: "\nSecond paragraph",
        label: " note ",
      }),
    ).toBe("[^note]:\n    Second paragraph");
  });
});
