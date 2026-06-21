import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  LanguageDescription,
  defaultHighlightStyle,
  syntaxTree,
  syntaxHighlighting,
} from "@codemirror/language";
import TurndownService from "turndown";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type ChangeDesc,
  Prec,
  Facet,
  type Range,
  type RangeSet,
  type Text,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  layer,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";
import { useEffect, useRef, useState } from "react";
import { resolveThreadAnchors } from "../../lib/anchorResolution";
import { measurePerf } from "../../lib/devPerf";
import { classifyFootnoteSelection, collectFootnoteDefinitions } from "../../lib/footnote";
import type { EditorMode } from "../../stores/uiStore";
import type { EditorSelectionSnapshot } from "../../types/thread";
import type { ThreadRecord } from "../../types/thread";
import {
  getProposalHunkAnchorPosition,
  proposalReviewDecorationsField,
  setProposalReviewEditorState,
  type ProposalReviewEditorState,
} from "./cm/proposalReviewExtension";

interface UseCodeMirrorOptions {
  editorMode?: EditorMode;
  initialValue: string;
  isFocusModeEnabled?: boolean;
  onActiveFootnoteDefinitionChange?: (footnoteDefinition: ActiveFootnoteDefinition | null) => void;
  onActiveLinkChange?: (link: ActiveMarkdownLink | null) => void;
  onCreateLinkRequested?: (selection: EditorSelectionSnapshot) => void;
  onFocusModeTypingActivity?: () => void;
  onImportImageAsset?: (file: File) => Promise<string>;
  onSaveRequested?: (content: string) => void;
  onSelectionChange?: (selection: EditorSelectionSnapshot | null) => void;
  onThreadSelect?: (threadId: string | null) => void;
  proposalReview?: ProposalReviewEditorState | null;
  resolveMarkdownImageSource?: (source: string) => string;
  selectedThreadId?: string | null;
  threads?: ThreadRecord[];
}

export interface CodeMirrorSession {
  createMarkdownLink: (
    selection: EditorSelectionSnapshot,
    nextValues: {
      label: string;
      title: string | null;
      url: string;
    },
  ) => void;
  focus: () => void;
  focusFootnoteDefinition: (footnoteDefinition: ActiveFootnoteDefinition) => void;
  getCharacterCount: () => number;
  getContent: () => string;
  getRangeRect: (from: number, to: number) => EditorViewportRect | null;
  getLineCount: () => number;
  getRevision: () => number;
  getSelectionSnapshot: () => EditorSelectionSnapshot | null;
  isDirty: () => boolean;
  markClean: () => void;
  openSearch: () => void;
  removeMarkdownLink: (link: ActiveMarkdownLink) => void;
  replaceContent: (nextContent: string, options?: { preserveViewport?: boolean }) => void;
  scrollToLine: (lineNumber: number) => void;
  updateFootnoteDefinition: (
    footnoteDefinition: ActiveFootnoteDefinition,
    nextValues: {
      content: string;
      label: string;
    },
  ) => void;
  updateMarkdownLink: (
    link: ActiveMarkdownLink,
    nextValues: {
      label: string;
      title: string | null;
      url: string;
    },
  ) => void;
}

export interface CodeMirrorSessionSnapshot {
  isDirty: boolean;
  revision: number;
}

export interface CodeMirrorSessionMetrics {
  characterCount: number;
  lineCount: number;
}

export interface EditorViewportRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

const SESSION_METRICS_UPDATE_DELAY_MS = 180;
const EMPTY_MARKDOWN_PASTE_PATTERN = /^[\s\\]*$/;
const SUPPORTED_IMAGE_MIME_PATTERN = /^image\/(png|jpe?g|gif|webp|avif)$/i;
let pendingImageInsertionId = 0;

const HEADING_MARKER_PATTERN = /^(?:\s{0,3})(#{1,6})(?:[ \t]+|$)/;
const BLOCKQUOTE_PATTERN = /^\s{0,3}>\s?/;
const BULLET_LIST_PATTERN = /^\s*[-+*]\s+/;
const ORDERED_LIST_PATTERN = /^\s*\d+[.)]\s+/;
const TASK_LIST_PATTERN = /^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;
const THEMATIC_BREAK_PATTERN = /^\s{0,3}(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/;
const CODE_FENCE_PATTERN = /^\s*(?:`{3,}|~{3,})/;
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([^\]\r\n]+)\]/g;
const MARKDOWN_IMAGE_LINE_PATTERN = /^(\s*)!\[([^\]\r\n]*)\]\(([^)\r\n]*)\)(\s*)$/;
const LOOSE_LOCAL_MARKDOWN_LINK_PATTERN =
  /\[([^\]\r\n]+)\]\(((?:~|\/|\.{1,2}\/)[^)\r\n]*\s[^)\r\n]*)\)/g;
const WIKILINK_PATTERN = /\[\[([^\]\r\n|]+)(?:\|([^\]\r\n]+))?\]\]/g;

const readableLineDecorationCache = new Map<string, Decoration>();
const hiddenMarkdownSyntaxDecoration = Decoration.mark({
  attributes: {
    "aria-hidden": "true",
  },
  class: "cm-md-syntax-hidden",
});
const renderedEmphasisContentDecoration = Decoration.mark({
  class: "cm-md-emphasis-content",
});
const renderedStrongContentDecoration = Decoration.mark({
  class: "cm-md-strong-content",
});
const renderedLooseLocalLinkLabelDecoration = Decoration.mark({
  class: "cm-md-loose-local-link-label",
});
const renderedWikiLinkLabelDecoration = Decoration.mark({
  class: "cm-md-wikilink-label",
});
const footnoteReferenceDecoration = Decoration.mark({
  class: "cm-md-footnote-ref",
});
const focusDimmedBlockDecoration = Decoration.mark({
  class: "cm-focus-dimmed-block",
});
const tableSyntaxDecoration = Decoration.mark({
  class: "cm-md-table-syntax",
});

const markdownImageSourceResolverFacet = Facet.define<
  (source: string) => string,
  (source: string) => string
>({
  combine: (values) => values[values.length - 1] ?? ((source) => source),
});

const REVEAL_NODE_PRIORITIES = new Map<string, number>([
  ["FencedCode", 100],
  ["ListItem", 90],
  ["Blockquote", 80],
  ["ATXHeading1", 70],
  ["ATXHeading2", 70],
  ["ATXHeading3", 70],
  ["ATXHeading4", 70],
  ["ATXHeading5", 70],
  ["ATXHeading6", 70],
  ["SetextHeading1", 70],
  ["SetextHeading2", 70],
  ["Paragraph", 60],
]);

const markdownCodeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx", "node"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then((module) => module.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx"],
    extensions: ["ts", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((module) =>
        module.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html", "xhtml"],
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then((module) => module.html()),
  }),
  LanguageDescription.of({
    name: "CSS",
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then((module) => module.css()),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json5"],
    extensions: ["json", "map"],
    load: () => import("@codemirror/lang-json").then((module) => module.json()),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then((module) => module.python()),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((module) => module.rust()),
  }),
  LanguageDescription.of({
    name: "SQL",
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then((module) => module.sql()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((module) => module.yaml()),
  }),
  LanguageDescription.of({
    name: "XML",
    extensions: ["xml", "svg"],
    load: () => import("@codemirror/lang-xml").then((module) => module.xml()),
  }),
];

const setEditorPresentationMode = StateEffect.define<EditorMode>();
const editorGutterCompartment = new Compartment();
const setEditorFocusMode = StateEffect.define<boolean>();

function editorGutterExtensionsForMode(mode: EditorMode) {
  return mode === "raw" ? [lineNumbers(), highlightActiveLineGutter()] : [];
}

const editorPresentationModeField = StateField.define<EditorMode>({
  create() {
    return "raw";
  },
  update(mode, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorPresentationMode)) {
        mode = effect.value;
      }
    }

    return mode;
  },
});

const editorFocusModeField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(isFocusModeEnabled, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocusMode)) {
        isFocusModeEnabled = effect.value;
      }
    }

    return isFocusModeEnabled;
  },
});

const setEditorCompositionState = StateEffect.define<boolean>();
export const editorCompositionStateField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(isComposing, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorCompositionState)) {
        isComposing = effect.value;
      }
    }

    return isComposing;
  },
});

const setEditorPointerSelectionState = StateEffect.define<boolean>();
const editorPointerSelectionStateField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(isSelecting, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorPointerSelectionState)) {
        isSelecting = effect.value;
      }
    }

    return isSelecting;
  },
});

interface PendingImageInsertionRange {
  from: number;
  id: string;
  to: number;
}

const addPendingImageInsertionRange = StateEffect.define<PendingImageInsertionRange>();
const removePendingImageInsertionRange = StateEffect.define<string>();

export const pendingImageInsertionRangeField = StateField.define<PendingImageInsertionRange[]>({
  create() {
    return [];
  },
  update(ranges, tr) {
    let nextRanges = ranges.map((range) => {
      const from = tr.changes.mapPos(range.from, 1);
      const to = tr.changes.mapPos(range.to, 1);
      return {
        ...range,
        from: Math.max(0, Math.min(from, tr.newDoc.length)),
        to: Math.max(0, Math.min(to, tr.newDoc.length)),
      };
    });

    for (const effect of tr.effects) {
      if (effect.is(addPendingImageInsertionRange)) {
        nextRanges = [...nextRanges, effect.value];
      } else if (effect.is(removePendingImageInsertionRange)) {
        nextRanges = nextRanges.filter((range) => range.id !== effect.value);
      }
    }

    return nextRanges.map((range) =>
      range.to < range.from
        ? {
            ...range,
            to: range.from,
          }
        : range,
    );
  },
});

export interface VisibleRangeSpec {
  from: number;
  to: number;
}

interface RevealRangeSpec extends VisibleRangeSpec {
  kind:
    | "footnote-definition"
    | "footnote-reference"
    | "selection"
    | "source-fallback"
    | "structured-link";
}

export interface ActiveMarkdownLink {
  from: number;
  label: string;
  labelFrom: number;
  labelTo: number;
  title: string | null;
  titleFrom: number | null;
  titleTo: number | null;
  to: number;
  url: string;
  urlFrom: number;
  urlTo: number;
}

export interface ActiveFootnoteDefinition {
  blockContent: string;
  content: string;
  from: number;
  label: string;
  to: number;
  tokenFrom: number;
  tokenTo: number;
}

interface RenderedMarkdownProjection {
  atomicRanges: DecorationSet;
  decorations: DecorationSet;
}

interface MarkdownTableRange extends RevealRangeSpec {
  endLine: number;
  startLine: number;
}

class MarkdownMarkerWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly className: string,
  ) {
    super();
  }

  eq(other: MarkdownMarkerWidget) {
    return this.text === other.text && this.className === other.className;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

class CodeBlockLanguageWidget extends WidgetType {
  constructor(private readonly language: string) {
    super();
  }

  eq(other: CodeBlockLanguageWidget) {
    return this.language === other.language;
  }

  toDOM() {
    const label = document.createElement("span");
    label.className = "cm-md-code-language-widget";
    label.textContent = this.language || "code";
    return label;
  }

  ignoreEvent() {
    return true;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly checkOffset: number,
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget) {
    return this.checked === other.checked && this.checkOffset === other.checkOffset;
  }

  toDOM(view: EditorView) {
    const checkbox = document.createElement("input");
    checkbox.className = "cm-md-task-checkbox-widget";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");

    const toggleTask = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        changes: {
          from: this.checkOffset,
          insert: this.checked ? " " : "x",
          to: this.checkOffset + 1,
        },
        selection: {
          anchor: this.checkOffset + 1,
        },
      });
      view.focus();
    };

    checkbox.addEventListener("click", toggleTask);
    return checkbox;
  }

  ignoreEvent() {
    return true;
  }
}

class MarkdownImageBlockWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly renderedSource: string,
    private readonly alt: string,
    private readonly from: number,
  ) {
    super();
  }

  eq(other: MarkdownImageBlockWidget) {
    return (
      this.source === other.source &&
      this.renderedSource === other.renderedSource &&
      this.alt === other.alt &&
      this.from === other.from
    );
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-image-block";
    wrapper.title = "Click to edit Markdown image source";
    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      view.dispatch({
        selection: {
          anchor: this.from,
        },
      });
      view.focus();
    });

    const image = document.createElement("img");
    image.alt = this.alt;
    image.draggable = false;
    image.src = this.renderedSource;
    wrapper.append(image);

    if (this.alt.trim()) {
      const caption = document.createElement("div");
      caption.className = "cm-md-image-caption";
      caption.textContent = this.alt;
      wrapper.append(caption);
    }

    return wrapper;
  }
}

interface MarkdownTablePreview {
  alignments: Array<"center" | "left" | "right" | null>;
  headers: string[];
  rows: string[][];
  source: string;
}

class MarkdownTablePreviewWidget extends WidgetType {
  constructor(
    private readonly preview: MarkdownTablePreview,
    private readonly from: number,
  ) {
    super();
  }

  eq(other: MarkdownTablePreviewWidget) {
    return this.from === other.from && this.preview.source === other.preview.source;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-block";
    wrapper.title = "Click to edit Markdown table source";
    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      view.dispatch({
        selection: {
          anchor: this.from,
        },
      });
      view.focus();
    });

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    this.preview.headers.forEach((cellText, index) => {
      const cell = document.createElement("th");
      applyTableCellAlignment(cell, this.preview.alignments[index] ?? null);
      cell.textContent = cellText;
      headerRow.append(cell);
    });
    thead.append(headerRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    this.preview.rows.forEach((row) => {
      const tableRow = document.createElement("tr");
      const columnCount = Math.max(this.preview.headers.length, row.length);
      for (let index = 0; index < columnCount; index += 1) {
        const cell = document.createElement("td");
        applyTableCellAlignment(cell, this.preview.alignments[index] ?? null);
        cell.textContent = row[index] ?? "";
        tableRow.append(cell);
      }
      tbody.append(tableRow);
    });
    table.append(tbody);
    wrapper.append(table);
    return wrapper;
  }
}

function applyTableCellAlignment(
  element: HTMLTableCellElement,
  alignment: "center" | "left" | "right" | null,
) {
  if (alignment) {
    element.style.textAlign = alignment;
  }
}

export function classifyReadableMarkdownLine(text: string): string[] {
  const classes = ["cm-md-line"];

  if (THEMATIC_BREAK_PATTERN.test(text)) {
    classes.push("cm-md-hr");
    return classes;
  }

  const headingMatch = text.match(HEADING_MARKER_PATTERN);
  if (headingMatch) {
    const level = Math.min(6, headingMatch[1].length);
    classes.push("cm-md-heading", `cm-md-h${level}`);
    return classes;
  }

  if (BLOCKQUOTE_PATTERN.test(text)) {
    classes.push("cm-md-blockquote");
    return classes;
  }

  if (ORDERED_LIST_PATTERN.test(text)) {
    classes.push("cm-md-list", "cm-md-list-ordered");
    return classes;
  }

  if (BULLET_LIST_PATTERN.test(text)) {
    classes.push("cm-md-list");
    return classes;
  }

  if (CODE_FENCE_PATTERN.test(text)) {
    classes.push("cm-md-code-fence");
    return classes;
  }

  return [];
}

function getReadableLineDecoration(className: string) {
  const cached = readableLineDecorationCache.get(className);
  if (cached) {
    return cached;
  }

  const decoration = Decoration.line({
    attributes: {
      class: className,
    },
  });
  readableLineDecorationCache.set(className, decoration);
  return decoration;
}

export function buildMarkdownImageBlockInsertion(
  state: EditorState,
  from: number,
  to: number,
  relativePath: string,
  fileName: string,
) {
  const imageMarkdown = `![${markdownImageAltFromFileName(fileName)}](${relativePath})`;
  const before = state.doc.sliceString(Math.max(0, from - 2), from);
  const after = state.doc.sliceString(to, Math.min(state.doc.length, to + 2));
  const prefix =
    from === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix =
    to === state.doc.length
      ? ""
      : after.startsWith("\n\n")
        ? ""
        : after.startsWith("\n")
          ? "\n"
          : "\n\n";

  return {
    anchor: from + prefix.length + imageMarkdown.length,
    insert: `${prefix}${imageMarkdown}${suffix}`,
  };
}

function markdownImageAltFromFileName(fileName: string) {
  const baseName = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const alt = baseName || "image";
  return alt.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function buildReadableMarkdownDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
): DecorationSet {
  return measurePerf(
    "buildReadableMarkdownDecorations",
    () => {
      const ranges = collectReadableMarkdownDecorationRanges(state, visibleRanges);
      return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
    },
    {
      docLength: state.doc.length,
      visibleRangeCount: visibleRanges.length,
    },
  );
}

function collectReadableMarkdownDecorationRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const ranges: Range<Decoration>[] = [];
  let previousLineNumber = 0;

  for (const visibleRange of visibleRanges) {
    const rangeEnd = Math.max(visibleRange.from, visibleRange.to - 1);
    let line = state.doc.lineAt(visibleRange.from);
    const endLineNumber = state.doc.lineAt(rangeEnd).number;

    while (true) {
      if (line.number > previousLineNumber) {
        const classNames = classifyReadableMarkdownLine(line.text);
        if (classNames.length > 0) {
          ranges.push(getReadableLineDecoration(classNames.join(" ")).range(line.from));
        }
        previousLineNumber = line.number;
      }

      if (line.number >= endLineNumber) {
        break;
      }

      line = state.doc.line(line.number + 1);
    }
  }

  return ranges;
}

function forEachVisibleLine(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
  callback: (line: ReturnType<Text["line"]>) => void,
) {
  let previousLineNumber = 0;

  for (const visibleRange of visibleRanges) {
    const rangeEnd = Math.max(visibleRange.from, visibleRange.to - 1);
    let line = state.doc.lineAt(visibleRange.from);
    const endLineNumber = state.doc.lineAt(rangeEnd).number;

    while (true) {
      if (line.number > previousLineNumber) {
        callback(line);
        previousLineNumber = line.number;
      }

      if (line.number >= endLineNumber) {
        break;
      }

      line = state.doc.line(line.number + 1);
    }
  }
}

export function buildRenderedMarkdownDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
  editorMode: EditorMode,
): DecorationSet {
  return buildRenderedMarkdownProjection(state, visibleRanges, editorMode).decorations;
}

function buildRenderedMarkdownProjection(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
  editorMode: EditorMode,
): RenderedMarkdownProjection {
  return measurePerf(
    "buildRenderedMarkdownDecorations",
    () => {
      if (editorMode !== "rendered" || isEditorCompositionActive(state)) {
        return {
          atomicRanges: Decoration.none,
          decorations: Decoration.none,
        };
      }

      const ranges = collectReadableMarkdownDecorationRanges(state, visibleRanges);
      const atomicRanges: Range<Decoration>[] = [];
      const hiddenSyntaxRanges = collectRenderedMarkdownSyntaxRanges(state, visibleRanges);
      const looseLocalLinkRanges = collectRenderedLooseLocalLinkRanges(state, visibleRanges);
      const wikiLinkRanges = collectRenderedWikiLinkRanges(state, visibleRanges);
      const inlineStyleRanges = collectRenderedInlineStyleRanges(state, visibleRanges);
      const imageBlockRanges = collectRenderedMarkdownImageBlockRanges(
        state,
        visibleRanges,
        state.facet(markdownImageSourceResolverFacet),
      );
      const tableRanges = collectRenderedMarkdownTableRanges(state, visibleRanges);
      const frontmatterRanges = collectRenderedFrontmatterRanges(state, visibleRanges);
      const fencedCodeRanges = collectRenderedFencedCodeRanges(state, visibleRanges);
      const taskListRanges = collectRenderedTaskListRanges(state, visibleRanges);
      const footnoteDefinitionRanges = collectRenderedFootnoteDefinitionRanges(state, visibleRanges);
      const footnoteReferenceRanges = collectRenderedFootnoteReferenceRanges(state, visibleRanges);
      ranges.push(...hiddenSyntaxRanges);
      ranges.push(...looseLocalLinkRanges.decorations);
      ranges.push(...wikiLinkRanges.decorations);
      ranges.push(...inlineStyleRanges);
      ranges.push(...imageBlockRanges);
      ranges.push(...tableRanges);
      ranges.push(...frontmatterRanges);
      ranges.push(...fencedCodeRanges.decorations);
      ranges.push(...taskListRanges.decorations);
      ranges.push(...footnoteDefinitionRanges);
      ranges.push(...footnoteReferenceRanges);
      atomicRanges.push(...hiddenSyntaxRanges);
      atomicRanges.push(...looseLocalLinkRanges.atomicRanges);
      atomicRanges.push(...wikiLinkRanges.atomicRanges);
      atomicRanges.push(...fencedCodeRanges.atomicRanges);
      atomicRanges.push(...taskListRanges.atomicRanges);

      return {
        atomicRanges:
          atomicRanges.length > 0 ? Decoration.set(atomicRanges, true) : Decoration.none,
        decorations: ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none,
      };
    },
    {
      docLength: state.doc.length,
      editorMode,
      visibleRangeCount: visibleRanges.length,
    },
  );
}

interface FencedCodeBlockRange {
  closingLineNumber: number | null;
  from: number;
  info: string;
  openingLineNumber: number;
  to: number;
}

function collectRenderedFencedCodeRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  if (visibleRanges.length === 0) {
    return { atomicRanges, decorations };
  }

  const revealRanges = getRevealRangesForState(state);
  for (const block of collectFencedCodeBlocks(state)) {
    if (
      !visibleRanges.some((visibleRange) =>
        rangesOverlap(block.from, block.to, visibleRange.from, visibleRange.to),
      )
    ) {
      continue;
    }

    if (isMarkdownSyntaxNodeVisible(block.from, block.to, revealRanges)) {
      continue;
    }

    const language = normalizeFenceInfoLanguage(block.info);
    const endLineNumber = state.doc.lineAt(block.to).number;
    for (
      let lineNumber = block.openingLineNumber;
      lineNumber <= endLineNumber;
      lineNumber += 1
    ) {
      const line = state.doc.line(lineNumber);
      const classNames = ["cm-md-line", "cm-md-code-block-line"];
      if (lineNumber === block.openingLineNumber) {
        classNames.push("cm-md-code-block-start");
      } else if (lineNumber === block.closingLineNumber) {
        classNames.push("cm-md-code-block-end");
      } else {
        classNames.push("cm-md-code-block-content");
      }
      decorations.push(getReadableLineDecoration(classNames.join(" ")).range(line.from));
    }

    const openingLine = state.doc.line(block.openingLineNumber);
    const openingHiddenRange = hiddenMarkdownSyntaxDecoration.range(
      openingLine.from,
      openingLine.to,
    );
    decorations.push(openingHiddenRange);
    atomicRanges.push(openingHiddenRange);
    decorations.push(
      Decoration.widget({
        side: -1,
        widget: new CodeBlockLanguageWidget(language),
      }).range(openingLine.from),
    );

    if (block.closingLineNumber !== null) {
      const closingLine = state.doc.line(block.closingLineNumber);
      const closingHiddenRange = hiddenMarkdownSyntaxDecoration.range(
        closingLine.from,
        closingLine.to,
      );
      decorations.push(closingHiddenRange);
      atomicRanges.push(closingHiddenRange);
    }
  }

  return { atomicRanges, decorations };
}

function collectFencedCodeBlocks(state: EditorState) {
  const blocks: FencedCodeBlockRange[] = [];
  let lineNumber = 1;

  while (lineNumber <= state.doc.lines) {
    const line = state.doc.line(lineNumber);
    const openingMatch = line.text.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (!openingMatch) {
      lineNumber += 1;
      continue;
    }

    const marker = openingMatch[2];
    const fenceCharacter = marker[0];
    const markerLength = marker.length;
    const info = openingMatch[3]?.trim() ?? "";
    let closingLineNumber: number | null = null;
    let endLine = line;
    let cursorLineNumber = lineNumber + 1;

    while (cursorLineNumber <= state.doc.lines) {
      const candidateLine = state.doc.line(cursorLineNumber);
      if (isClosingFenceLine(candidateLine.text, fenceCharacter, markerLength)) {
        closingLineNumber = candidateLine.number;
        endLine = candidateLine;
        break;
      }
      endLine = candidateLine;
      cursorLineNumber += 1;
    }

    blocks.push({
      closingLineNumber,
      from: line.from,
      info,
      openingLineNumber: line.number,
      to: endLine.to,
    });

    lineNumber = endLine.number + 1;
  }

  return blocks;
}

function isClosingFenceLine(text: string, fenceCharacter: string, openingFenceLength: number) {
  const closingMatch = text.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
  return (
    !!closingMatch &&
    closingMatch[1][0] === fenceCharacter &&
    closingMatch[1].length >= openingFenceLength
  );
}

function normalizeFenceInfoLanguage(info: string) {
  const language = info.split(/\s+/)[0]?.replace(/[^\w.+-]/g, "") ?? "";
  return language || "code";
}

function collectRenderedFrontmatterRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const frontmatter = collectYamlFrontmatterRange(state);
  if (
    !frontmatter ||
    !visibleRanges.some((visibleRange) =>
      rangesOverlap(frontmatter.from, frontmatter.to, visibleRange.from, visibleRange.to),
    )
  ) {
    return [] as Range<Decoration>[];
  }

  const ranges: Range<Decoration>[] = [];
  for (let lineNumber = frontmatter.startLine; lineNumber <= frontmatter.endLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const classNames = ["cm-md-line", "cm-md-frontmatter"];
    if (lineNumber === frontmatter.startLine) {
      classNames.push("cm-md-frontmatter-start");
    } else if (lineNumber === frontmatter.endLine) {
      classNames.push("cm-md-frontmatter-end");
    } else {
      classNames.push("cm-md-frontmatter-content");
    }
    ranges.push(getReadableLineDecoration(classNames.join(" ")).range(line.from));
  }

  return ranges;
}

function collectYamlFrontmatterRange(state: EditorState) {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== "---") {
    return null;
  }

  for (let lineNumber = 2; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const trimmed = line.text.trim();
    if (trimmed === "---" || trimmed === "...") {
      return {
        endLine: lineNumber,
        from: state.doc.line(1).from,
        startLine: 1,
        to: line.to,
      };
    }
  }

  return null;
}

function collectRenderedTaskListRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  if (visibleRanges.length === 0) {
    return { atomicRanges, decorations };
  }

  const revealRanges = getRevealRangesForState(state);

  forEachVisibleLine(state, visibleRanges, (line) => {
    const match = line.text.match(TASK_LIST_PATTERN);
    if (!match) {
      return;
    }

    if (isMarkdownSyntaxNodeVisible(line.from, line.to, revealRanges)) {
      return;
    }

    const markerStart = line.from + match[1].length;
    const markerEnd = markerStart + 3;
    const checkOffset = markerStart + 1;
    const checked = match[2].toLowerCase() === "x";
    const hiddenRange = hiddenMarkdownSyntaxDecoration.range(markerStart, markerEnd);
    decorations.push(hiddenRange);
    decorations.push(
      Decoration.widget({
        side: -1,
        widget: new TaskCheckboxWidget(checked, checkOffset),
      }).range(markerStart),
    );
    atomicRanges.push(hiddenRange);
  });

  return { atomicRanges, decorations };
}

function collectRenderedFootnoteDefinitionRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const revealRanges = getRevealRangesForState(state);
  const ranges: Range<Decoration>[] = [];
  const definitions = getFootnoteDefinitionsForState(state);

  for (const definition of definitions) {
    if (
      !visibleRanges.some((visibleRange) =>
        rangesOverlap(
          definition.blockStartOffsetUtf16,
          definition.blockEndOffsetUtf16,
          visibleRange.from,
          visibleRange.to,
        ),
      )
    ) {
      continue;
    }

    if (
      isMarkdownSyntaxNodeVisible(
        definition.blockStartOffsetUtf16,
        definition.blockEndOffsetUtf16,
        revealRanges,
      )
    ) {
      continue;
    }

    let hiddenTokenEnd = definition.tokenEndOffsetUtf16;
    while (hiddenTokenEnd < definition.blockEndOffsetUtf16) {
      const trailingWhitespace = state.doc.sliceString(hiddenTokenEnd, hiddenTokenEnd + 1);
      if (trailingWhitespace !== " " && trailingWhitespace !== "\t") {
        break;
      }
      hiddenTokenEnd += 1;
    }

    ranges.push(
      hiddenMarkdownSyntaxDecoration.range(
        definition.tokenStartOffsetUtf16,
        hiddenTokenEnd,
      ),
    );

    for (let lineNumber = definition.startLine; lineNumber <= definition.endLine; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      ranges.push(getReadableLineDecoration("cm-md-line cm-md-footnote-definition").range(line.from));

      if (lineNumber === definition.startLine) {
        continue;
      }

      const indentMatch = line.text.match(/^(?: {4,}|\t+)/);
      if (!indentMatch) {
        continue;
      }

      ranges.push(
        hiddenMarkdownSyntaxDecoration.range(line.from, line.from + indentMatch[0].length),
      );
    }
  }

  return ranges;
}

function collectRenderedFootnoteReferenceRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const revealRanges = getRevealRangesForState(state);
  const ranges: Range<Decoration>[] = [];
  const seenStarts = new Set<number>();
  const definedLabels = getFootnoteLabelsForState(state);

  for (const visibleRange of visibleRanges) {
    const rangeEnd = Math.max(visibleRange.from, visibleRange.to - 1);
    const startLine = state.doc.lineAt(visibleRange.from);
    const endLine = state.doc.lineAt(rangeEnd);
    const scanFrom = startLine.from;
    const scanTo = endLine.to;
    const segment = state.doc.sliceString(scanFrom, scanTo);

    for (const match of segment.matchAll(FOOTNOTE_REFERENCE_PATTERN)) {
      const tokenStart = scanFrom + (match.index ?? 0);
      const tokenEnd = tokenStart + match[0].length;
      const label = match[1] ?? "";

      if (
        seenStarts.has(tokenStart) ||
        !definedLabels.has(label) ||
        isFootnoteDefinitionToken(state, tokenEnd) ||
        isFootnoteReferenceInExcludedContext(state, tokenStart, tokenEnd) ||
        !isLikelyRenderableFootnoteReference(state, tokenStart)
      ) {
        continue;
      }

      seenStarts.add(tokenStart);

      if (isMarkdownSyntaxNodeVisible(tokenStart, tokenEnd, revealRanges)) {
        continue;
      }

      ranges.push(hiddenMarkdownSyntaxDecoration.range(tokenStart, tokenStart + 1));
      ranges.push(hiddenMarkdownSyntaxDecoration.range(tokenStart + 1, tokenStart + 2));
      ranges.push(hiddenMarkdownSyntaxDecoration.range(tokenEnd - 1, tokenEnd));

      if (tokenStart + 2 < tokenEnd - 1) {
        ranges.push(footnoteReferenceDecoration.range(tokenStart + 2, tokenEnd - 1));
      }
    }
  }

  return ranges;
}

function isFootnoteDefinitionToken(state: EditorState, tokenEnd: number) {
  return state.doc.sliceString(tokenEnd, tokenEnd + 1) === ":";
}

function isLikelyRenderableFootnoteReference(state: EditorState, tokenStart: number) {
  if (tokenStart === 0) {
    return false;
  }

  const previousCharacter = state.doc.sliceString(tokenStart - 1, tokenStart);
  if (!previousCharacter || /\s/.test(previousCharacter)) {
    return false;
  }

  return !/[[({<"'`]/.test(previousCharacter);
}

function isFootnoteReferenceInExcludedContext(
  state: EditorState,
  from: number,
  to: number,
) {
  return (
    isPositionInsideExcludedFootnoteContext(state, from) ||
    isPositionInsideExcludedFootnoteContext(state, Math.max(from, to - 1))
  );
}

function isPositionInsideExcludedFootnoteContext(state: EditorState, position: number) {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1);

  while (node) {
    switch (node.name) {
      case "InlineCode":
      case "CodeText":
      case "FencedCode":
        return true;
      default:
        node = node.parent;
        break;
    }
  }

  return false;
}

function collectRenderedMarkdownSyntaxRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const revealRanges = getRevealRangesForState(state);
  const sourceFallbackRanges = collectRenderedSourceFallbackRanges(state, visibleRanges);
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  for (const visibleRange of visibleRanges) {
    tree.iterate({
      from: visibleRange.from,
      to: visibleRange.to,
      enter(node) {
        if (
          !shouldHideMarkdownSyntaxNode(
            state,
            node.node,
            revealRanges,
            sourceFallbackRanges,
          )
        ) {
          return;
        }

        ranges.push(hiddenMarkdownSyntaxDecoration.range(node.from, node.to));

        if (node.name === "ListMark" && !isTaskListLineAt(state, node.from)) {
          const markerText = state.doc.sliceString(node.from, node.to);
          const renderedMarkerText = markerText.match(/^\d+[.)]/)?.[0] ?? "•";
          const widgetClassName =
            renderedMarkerText === "•"
              ? "cm-md-list-marker-widget"
              : "cm-md-list-marker-widget cm-md-list-marker-widget-ordered";
          ranges.push(
            Decoration.widget({
              side: -1,
              widget: new MarkdownMarkerWidget(renderedMarkerText, widgetClassName),
            }).range(node.from),
          );
        }
      },
    });
  }

  return ranges;
}

function isTaskListLineAt(state: EditorState, position: number) {
  return TASK_LIST_PATTERN.test(state.doc.lineAt(position).text);
}

function collectRenderedLooseLocalLinkRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  if (visibleRanges.length === 0) {
    return { atomicRanges, decorations };
  }

  for (const link of getLooseLocalMarkdownLinksForState(state)) {
    if (
      !visibleRanges.some((visibleRange) =>
        rangesOverlap(link.from, link.to, visibleRange.from, visibleRange.to),
      )
    ) {
      continue;
    }

    if (isRangeInsideExcludedMarkdownContext(state, link.from, link.to)) {
      continue;
    }

    decorations.push(renderedLooseLocalLinkLabelDecoration.range(link.labelFrom, link.labelTo));

    for (const [from, to] of [
      [link.from, link.labelFrom],
      [link.labelTo, link.urlFrom],
      [link.urlFrom, link.urlTo],
      [link.urlTo, link.to],
    ] as const) {
      const range = hiddenMarkdownSyntaxDecoration.range(from, to);
      decorations.push(range);
      atomicRanges.push(range);
    }
  }

  return { atomicRanges, decorations };
}

interface WikiLinkRange {
  from: number;
  labelFrom: number;
  labelTo: number;
  to: number;
}

const wikiLinksCache = new WeakMap<EditorState, WikiLinkRange[]>();

function getWikiLinksForState(state: EditorState) {
  const cachedLinks = wikiLinksCache.get(state);
  if (cachedLinks) {
    return cachedLinks;
  }

  const links = collectWikiLinks(getDocumentTextForState(state));
  wikiLinksCache.set(state, links);
  return links;
}

function collectRenderedWikiLinkRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  if (visibleRanges.length === 0) {
    return { atomicRanges, decorations };
  }

  const revealRanges = getRevealRangesForState(state);
  const sourceFallbackRanges = collectRenderedSourceFallbackRanges(state, visibleRanges);
  for (const link of getWikiLinksForState(state)) {
    if (
      !visibleRanges.some((visibleRange) =>
        rangesOverlap(link.from, link.to, visibleRange.from, visibleRange.to),
      )
    ) {
      continue;
    }

    if (
      isMarkdownSyntaxNodeVisible(link.from, link.to, revealRanges) ||
      isMarkdownSyntaxNodeVisible(link.from, link.to, sourceFallbackRanges) ||
      isRangeInsideExcludedMarkdownContext(state, link.from, link.to)
    ) {
      continue;
    }

    decorations.push(renderedWikiLinkLabelDecoration.range(link.labelFrom, link.labelTo));
    for (const [from, to] of [
      [link.from, link.labelFrom],
      [link.labelTo, link.to],
    ] as const) {
      if (from >= to) {
        continue;
      }
      const range = hiddenMarkdownSyntaxDecoration.range(from, to);
      decorations.push(range);
      atomicRanges.push(range);
    }
  }

  return { atomicRanges, decorations };
}

function collectWikiLinks(docText: string) {
  const links: WikiLinkRange[] = [];
  WIKILINK_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = WIKILINK_PATTERN.exec(docText))) {
    const target = match[1];
    const alias = match[2] ?? null;
    const from = match.index;
    if (from > 0 && docText[from - 1] === "!") {
      continue;
    }

    const to = from + match[0].length;
    const targetFrom = from + 2;
    const targetTo = targetFrom + target.length;
    const label = alias ?? target;
    const labelFrom = alias ? targetTo + 1 : targetFrom;
    const labelTo = labelFrom + label.length;

    links.push({
      from,
      labelFrom,
      labelTo,
      to,
    });
  }

  return links;
}

function collectLooseLocalMarkdownLinks(docText: string): ActiveMarkdownLink[] {
  const links: ActiveMarkdownLink[] = [];
  LOOSE_LOCAL_MARKDOWN_LINK_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = LOOSE_LOCAL_MARKDOWN_LINK_PATTERN.exec(docText))) {
    const fullText = match[0];
    const label = match[1];
    const url = match[2];
    const from = match.index;
    const labelFrom = from + 1;
    const labelTo = labelFrom + label.length;
    const urlFrom = labelTo + 2;
    const urlTo = urlFrom + url.length;
    const to = from + fullText.length;

    links.push({
      from,
      label,
      labelFrom,
      labelTo,
      title: null,
      titleFrom: null,
      titleTo: null,
      to,
      url,
      urlFrom,
      urlTo,
    });
  }

  return links;
}

function isRangeInsideExcludedMarkdownContext(state: EditorState, from: number, to: number) {
  return (
    isPositionInsideExcludedFootnoteContext(state, from) ||
    isPositionInsideExcludedFootnoteContext(state, Math.max(from, to - 1))
  );
}

function collectRenderedInlineStyleRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const sourceFallbackRanges = collectRenderedSourceFallbackRanges(state, visibleRanges);
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  for (const visibleRange of visibleRanges) {
    tree.iterate({
      from: visibleRange.from,
      to: visibleRange.to,
      enter(node) {
        if (node.name !== "Emphasis" && node.name !== "StrongEmphasis") {
          return;
        }

        if (isMarkdownSyntaxNodeVisible(node.from, node.to, sourceFallbackRanges)) {
          return;
        }

        const contentRange = getInlineStyleContentRange(node.node);
        if (!contentRange || contentRange.from >= contentRange.to) {
          return;
        }

        ranges.push(
          (node.name === "Emphasis"
            ? renderedEmphasisContentDecoration
            : renderedStrongContentDecoration
          ).range(contentRange.from, contentRange.to),
        );
      },
    });
  }

  return ranges;
}

function getInlineStyleContentRange(node: SyntaxNode) {
  let from = node.from;
  let to = node.to;

  if (node.firstChild?.name === "EmphasisMark") {
    from = node.firstChild.to;
  }

  if (node.lastChild?.name === "EmphasisMark") {
    to = node.lastChild.from;
  }

  return { from, to };
}

function collectRenderedMarkdownImageBlockRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
  resolveSource: (source: string) => string,
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const revealRanges = getRevealRangesForState(state);
  const ranges: Range<Decoration>[] = [];

  forEachVisibleLine(state, visibleRanges, (line) => {
    const image = parseStandaloneMarkdownImageLine(line.text);
    if (!image) {
      return;
    }

    if (isMarkdownSyntaxNodeVisible(line.from, line.to, revealRanges)) {
      return;
    }

    ranges.push(
      Decoration.widget({
        side: -1,
        widget: new MarkdownImageBlockWidget(
          image.source,
          resolveSource(image.source),
          image.alt,
          line.from,
        ),
      }).range(line.from),
    );
    ranges.push(hiddenMarkdownSyntaxDecoration.range(line.from, line.to));
  });

  return ranges;
}

function parseStandaloneMarkdownImageLine(text: string) {
  const match = text.match(MARKDOWN_IMAGE_LINE_PATTERN);
  if (!match) {
    return null;
  }

  const source = extractMarkdownImageDestination(match[3] ?? "");
  if (!source) {
    return null;
  }

  return {
    alt: match[2] ?? "",
    source,
  };
}

function extractMarkdownImageDestination(rawDestination: string) {
  const trimmed = rawDestination.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("<")) {
    const closingIndex = trimmed.indexOf(">");
    return closingIndex > 1 ? trimmed.slice(1, closingIndex).trim() : "";
  }

  return trimmed.split(/\s+/)[0] ?? "";
}

function getFirstSupportedImageFile(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) {
    return null;
  }

  return (
    Array.from(dataTransfer.files).find((file) => SUPPORTED_IMAGE_MIME_PATTERN.test(file.type)) ??
    null
  );
}

function findPendingImageInsertionRange(state: EditorState, id: string) {
  return state
    .field(pendingImageInsertionRangeField, false)
    ?.find((range) => range.id === id);
}

export async function importImageFileAtSelection(
  view: EditorView,
  file: File,
  importImageAsset: (file: File) => Promise<string>,
  position?: number | null,
) {
  const id = `image-import-${++pendingImageInsertionId}`;
  const selection =
    typeof position === "number"
      ? {
          from: clampPosition(position, view.state.doc.length),
          to: clampPosition(position, view.state.doc.length),
        }
      : view.state.selection.main;

  view.dispatch({
    effects: addPendingImageInsertionRange.of({
      from: selection.from,
      id,
      to: selection.to,
    }),
  });

  try {
    const relativePath = await importImageAsset(file);
    const pendingRange = findPendingImageInsertionRange(view.state, id);
    if (!pendingRange) {
      return;
    }

    const from = clampPosition(pendingRange.from, view.state.doc.length);
    const to = Math.max(from, clampPosition(pendingRange.to, view.state.doc.length));
    const insertion = buildMarkdownImageBlockInsertion(
      view.state,
      from,
      to,
      relativePath,
      file.name,
    );

    view.dispatch({
      changes: {
        from,
        insert: insertion.insert,
        to,
      },
      effects: removePendingImageInsertionRange.of(id),
      selection: {
        anchor: insertion.anchor,
      },
    });
    view.focus();
  } catch (error) {
    view.dispatch({
      effects: removePendingImageInsertionRange.of(id),
    });
    throw error;
  }
}

// Three rendered-mode collectors request the fallback ranges with the same
// (state, visibleRanges) pair during one projection build; memoize on state
// plus visible-range array identity so the syntax-tree walk runs once.
const sourceFallbackRangesCache = new WeakMap<
  EditorState,
  { result: RevealRangeSpec[]; visibleRanges: readonly VisibleRangeSpec[] }
>();

function collectRenderedSourceFallbackRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  const cached = sourceFallbackRangesCache.get(state);
  if (cached && cached.visibleRanges === visibleRanges) {
    return cached.result;
  }

  const ranges: RevealRangeSpec[] = [];
  const tree = syntaxTree(state);
  const revealRanges = getRevealRangesForState(state);
  const seenRanges = new Set<string>();

  for (const visibleRange of visibleRanges) {
    for (const htmlRange of collectInlineHtmlContainerRanges(state, visibleRange)) {
      const key = `${htmlRange.from}:${htmlRange.to}`;
      if (seenRanges.has(key)) {
        continue;
      }
      seenRanges.add(key);
      ranges.push(htmlRange);
    }

    for (const tableRange of collectMarkdownTableRanges(state)) {
      if (
        !rangesOverlap(tableRange.from, tableRange.to, visibleRange.from, visibleRange.to) ||
        !isMarkdownSyntaxNodeVisible(tableRange.from, tableRange.to, revealRanges)
      ) {
        continue;
      }

      const key = `${tableRange.from}:${tableRange.to}`;
      if (seenRanges.has(key)) {
        continue;
      }
      seenRanges.add(key);
      ranges.push(tableRange);
    }

    tree.iterate({
      from: visibleRange.from,
      to: visibleRange.to,
      enter(node) {
        if (node.name === "Image") {
          if (isStandaloneMarkdownImageNode(state, node.from, node.to)) {
            return;
          }

          const key = `${node.from}:${node.to}`;
          if (seenRanges.has(key)) {
            return;
          }
          seenRanges.add(key);
          ranges.push({
            from: node.from,
            kind: "source-fallback",
            to: node.to,
          });
          return;
        }

        if (node.name === "HTMLBlock") {
          const key = `${node.from}:${node.to}`;
          if (seenRanges.has(key)) {
            return;
          }
          seenRanges.add(key);
          ranges.push({
            from: node.from,
            kind: "source-fallback",
            to: node.to,
          });
          return;
        }

        if (node.name === "HTMLTag") {
          const key = `${node.from}:${node.to}`;
          if (seenRanges.has(key)) {
            return;
          }
          seenRanges.add(key);
          ranges.push({
            from: node.from,
            kind: "source-fallback",
            to: node.to,
          });
        }
      },
    });

  }

  const mergedRanges = mergeRevealRanges(ranges);
  sourceFallbackRangesCache.set(state, { result: mergedRanges, visibleRanges });
  return mergedRanges;
}

function isStandaloneMarkdownImageNode(state: EditorState, from: number, to: number) {
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(Math.max(from, to - 1));
  if (startLine.number !== endLine.number) {
    return false;
  }

  const image = parseStandaloneMarkdownImageLine(startLine.text);
  return !!image && startLine.from + startLine.text.indexOf("!") === from;
}

function collectInlineHtmlContainerRanges(state: EditorState, visibleRange: VisibleRangeSpec) {
  const ranges: RevealRangeSpec[] = [];
  const rangeEnd = Math.max(visibleRange.from, visibleRange.to - 1);
  const startLine = state.doc.lineAt(visibleRange.from);
  const endLine = state.doc.lineAt(rangeEnd);

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const tagPattern = /<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
    for (const match of line.text.matchAll(tagPattern)) {
      const start = line.from + (match.index ?? 0);
      const end = start + match[0].length;
      if (!rangesOverlap(start, end, visibleRange.from, visibleRange.to)) {
        continue;
      }

      ranges.push({
        from: start,
        kind: "source-fallback",
        to: end,
      });
    }
  }

  return ranges;
}

function collectRenderedMarkdownTableRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  if (visibleRanges.length === 0) {
    return [] as Range<Decoration>[];
  }

  const ranges: Range<Decoration>[] = [];
  const revealRanges = getRevealRangesForState(state);
  for (const tableRange of collectMarkdownTableRanges(state)) {
    if (
      !visibleRanges.some((visibleRange) =>
        rangesOverlap(tableRange.from, tableRange.to, visibleRange.from, visibleRange.to),
      )
    ) {
      continue;
    }

    const canRenderPreview = visibleRanges.some(
      (visibleRange) => tableRange.from >= visibleRange.from && tableRange.from <= visibleRange.to,
    );
    if (canRenderPreview && !isMarkdownSyntaxNodeVisible(tableRange.from, tableRange.to, revealRanges)) {
      const preview = buildMarkdownTablePreview(state, tableRange);
      if (preview) {
        ranges.push(
          Decoration.widget({
            side: -1,
            widget: new MarkdownTablePreviewWidget(preview, tableRange.from),
          }).range(tableRange.from),
        );
        ranges.push(hiddenMarkdownSyntaxDecoration.range(tableRange.from, tableRange.to));
        continue;
      }
    }

    for (let lineNumber = tableRange.startLine; lineNumber <= tableRange.endLine; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const classes = ["cm-md-line", "cm-md-table-line"];
      if (lineNumber === tableRange.startLine) {
        classes.push("cm-md-table-header");
      } else if (lineNumber === tableRange.startLine + 1) {
        classes.push("cm-md-table-divider");
      } else if (lineNumber === tableRange.endLine) {
        classes.push("cm-md-table-last");
      }
      ranges.push(getReadableLineDecoration(classes.join(" ")).range(line.from));
      ranges.push(...collectTableSyntaxMarks(line, lineNumber === tableRange.startLine + 1));
    }
  }

  return ranges;
}

function buildMarkdownTablePreview(
  state: EditorState,
  tableRange: MarkdownTableRange,
): MarkdownTablePreview | null {
  const headerLine = state.doc.line(tableRange.startLine);
  const dividerLine = state.doc.line(tableRange.startLine + 1);
  const headers = splitMarkdownTableRow(headerLine.text).map(cleanMarkdownTableCell);
  const alignments = splitMarkdownTableRow(dividerLine.text).map(readMarkdownTableAlignment);
  if (headers.length < 2 || alignments.length < 2) {
    return null;
  }

  const rows: string[][] = [];
  for (let lineNumber = tableRange.startLine + 2; lineNumber <= tableRange.endLine; lineNumber += 1) {
    rows.push(splitMarkdownTableRow(state.doc.line(lineNumber).text).map(cleanMarkdownTableCell));
  }

  return {
    alignments,
    headers,
    rows,
    source: state.doc.sliceString(tableRange.from, tableRange.to),
  };
}

function splitMarkdownTableRow(text: string) {
  let trimmed = text.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";
  let isEscaped = false;
  for (const character of trimmed) {
    if (character === "|" && !isEscaped) {
      cells.push(current);
      current = "";
      continue;
    }

    current += character;
    isEscaped = character === "\\" && !isEscaped;
    if (character !== "\\") {
      isEscaped = false;
    }
  }
  cells.push(current);
  return cells;
}

function cleanMarkdownTableCell(text: string) {
  return text.trim().replace(/\\\|/g, "|").replace(/\s+/g, " ");
}

function readMarkdownTableAlignment(text: string): "center" | "left" | "right" | null {
  const trimmed = text.trim();
  const starts = trimmed.startsWith(":");
  const ends = trimmed.endsWith(":");
  if (starts && ends) {
    return "center";
  }
  if (ends) {
    return "right";
  }
  if (starts) {
    return "left";
  }
  return null;
}

function collectTableSyntaxMarks(line: ReturnType<Text["line"]>, isDividerLine: boolean) {
  const ranges: Range<Decoration>[] = [];
  if (isDividerLine) {
    ranges.push(tableSyntaxDecoration.range(line.from, line.to));
    return ranges;
  }

  for (const match of line.text.matchAll(/\|/g)) {
    const from = line.from + (match.index ?? 0);
    ranges.push(tableSyntaxDecoration.range(from, from + 1));
  }

  return ranges;
}

// Full-document scan; memoized per immutable EditorState because several
// rendered-mode collectors consult table ranges within a single projection
// build. Cached arrays are treated as read-only by all callers.
const markdownTableRangesCache = new WeakMap<EditorState, MarkdownTableRange[]>();

function collectMarkdownTableRanges(state: EditorState) {
  const cachedRanges = markdownTableRangesCache.get(state);
  if (cachedRanges) {
    return cachedRanges;
  }

  const ranges: MarkdownTableRange[] = [];
  const seenRanges = new Set<string>();
  let line = state.doc.line(1);

  while (line.number <= state.doc.lines) {
    const nextLineNumber = line.number + 1;
    if (nextLineNumber > state.doc.lines) {
      break;
    }

    const nextLine = state.doc.line(nextLineNumber);
    if (looksLikeMarkdownTableHeader(line.text) && looksLikeMarkdownTableDivider(nextLine.text)) {
      let tableEndLine = nextLine;
      let cursorLineNumber = nextLine.number + 1;
      while (cursorLineNumber <= state.doc.lines) {
        const candidateLine = state.doc.line(cursorLineNumber);
        if (!looksLikeMarkdownTableRow(candidateLine.text)) {
          break;
        }
        tableEndLine = candidateLine;
        cursorLineNumber += 1;
      }

      const key = `${line.from}:${tableEndLine.to}`;
      if (!seenRanges.has(key)) {
        seenRanges.add(key);
        ranges.push({
          endLine: tableEndLine.number,
          from: line.from,
          kind: "source-fallback",
          startLine: line.number,
          to: tableEndLine.to,
        });
      }

      line =
        tableEndLine.number < state.doc.lines
          ? state.doc.line(tableEndLine.number + 1)
          : tableEndLine;
      if (line.number === tableEndLine.number) {
        break;
      }
      continue;
    }

    if (line.number >= state.doc.lines) {
      break;
    }

    line = state.doc.line(line.number + 1);
  }

  markdownTableRangesCache.set(state, ranges);
  return ranges;
}

function looksLikeMarkdownTableHeader(text: string) {
  const trimmed = text.trim();
  const pipeCount = (trimmed.match(/\|/g) ?? []).length;
  return pipeCount >= 2 || trimmed.startsWith("|") || trimmed.endsWith("|");
}

function looksLikeMarkdownTableDivider(text: string) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(text);
}

function looksLikeMarkdownTableRow(text: string) {
  return text.trim().length > 0 && text.includes("|");
}

function shouldHideMarkdownSyntaxNode(
  state: EditorState,
  node: SyntaxNode,
  revealRanges: readonly RevealRangeSpec[],
  sourceFallbackRanges: readonly RevealRangeSpec[],
) {
  if (isMarkdownSyntaxNodeVisible(node.from, node.to, sourceFallbackRanges)) {
    return false;
  }

  if (isInlineMarkdownLinkSyntaxNode(state, node) || isInlineEmphasisSyntaxNode(node)) {
    return true;
  }

  if (isMarkdownSyntaxNodeVisible(node.from, node.to, revealRanges)) {
    return false;
  }

  switch (node.name) {
    case "HeaderMark":
    case "QuoteMark":
    case "ListMark":
    case "EmphasisMark":
    case "LinkMark":
    case "URL":
    case "LinkTitle":
      return true;
    case "CodeMark":
      return node.to - node.from === 1;
    default:
      return false;
  }
}

function isInlineMarkdownLinkSyntaxNode(state: EditorState, node: SyntaxNode) {
  if (node.name !== "LinkMark" && node.name !== "URL" && node.name !== "LinkTitle") {
    return false;
  }

  let parent = node.parent;
  while (parent && parent.name !== "Link") {
    parent = parent.parent;
  }

  if (!parent) {
    return false;
  }

  return state.doc.sliceString(parent.from, parent.to).includes("](");
}

function isInlineEmphasisSyntaxNode(node: SyntaxNode) {
  if (node.name !== "EmphasisMark") {
    return false;
  }

  let parent = node.parent;
  while (parent) {
    if (parent.name === "Emphasis" || parent.name === "StrongEmphasis") {
      return true;
    }
    parent = parent.parent;
  }

  return false;
}

// Selection-derived reveal ranges are pure per immutable EditorState and are
// requested by most rendered-mode collectors in one projection build; memoize
// so each state computes them once. Cached arrays are read-only to callers.
const revealRangesCache = new WeakMap<EditorState, RevealRangeSpec[]>();
const documentTextCache = new WeakMap<EditorState, string>();
const footnoteDefinitionsCache = new WeakMap<
  EditorState,
  ReturnType<typeof collectFootnoteDefinitions>
>();
const footnoteLabelsCache = new WeakMap<EditorState, Set<string>>();
const looseLocalMarkdownLinksCache = new WeakMap<
  EditorState,
  ReturnType<typeof collectLooseLocalMarkdownLinks>
>();

function getRevealRangesForState(state: EditorState) {
  const cachedRanges = revealRangesCache.get(state);
  if (cachedRanges) {
    return cachedRanges;
  }

  const revealRanges: RevealRangeSpec[] = [];
  const tree = syntaxTree(state);

  for (const range of state.selection.ranges) {
    revealRanges.push(...getRevealRangesForSelection(state, tree, range.from, range.to));
  }

  const mergedRanges = mergeRevealRanges(revealRanges);
  revealRangesCache.set(state, mergedRanges);
  return mergedRanges;
}

function getDocumentTextForState(state: EditorState) {
  const cachedText = documentTextCache.get(state);
  if (cachedText !== undefined) {
    return cachedText;
  }

  const text = state.doc.toString();
  documentTextCache.set(state, text);
  return text;
}

function getFootnoteDefinitionsForState(state: EditorState) {
  const cachedDefinitions = footnoteDefinitionsCache.get(state);
  if (cachedDefinitions) {
    return cachedDefinitions;
  }

  const definitions = collectFootnoteDefinitions(getDocumentTextForState(state));
  footnoteDefinitionsCache.set(state, definitions);
  return definitions;
}

function getFootnoteLabelsForState(state: EditorState) {
  const cachedLabels = footnoteLabelsCache.get(state);
  if (cachedLabels) {
    return cachedLabels;
  }

  const labels = new Set(
    getFootnoteDefinitionsForState(state).map((definition) => definition.label),
  );
  footnoteLabelsCache.set(state, labels);
  return labels;
}

function getLooseLocalMarkdownLinksForState(state: EditorState) {
  const cachedLinks = looseLocalMarkdownLinksCache.get(state);
  if (cachedLinks) {
    return cachedLinks;
  }

  const links = collectLooseLocalMarkdownLinks(getDocumentTextForState(state));
  looseLocalMarkdownLinksCache.set(state, links);
  return links;
}

function revealRangesEqual(left: readonly RevealRangeSpec[], right: readonly RevealRangeSpec[]) {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (range, index) =>
      range.from === right[index]?.from &&
      range.to === right[index]?.to &&
      range.kind === right[index]?.kind,
  );
}

function getRevealRangesForSelection(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree>,
  from: number,
  to: number,
) {
  const activeLink = readActiveMarkdownLinkAtSelection(state, tree, from, to);
  if (activeLink) {
    return [
      {
        from: activeLink.from,
        kind: "structured-link" as const,
        to: activeLink.to,
      },
    ];
  }

  const activeFootnoteReference = readActiveFootnoteReferenceAtSelection(state, from, to);
  if (activeFootnoteReference) {
    return [
      {
        from: activeFootnoteReference.from,
        kind: "footnote-reference" as const,
        to: activeFootnoteReference.to,
      },
    ];
  }

  const activeFootnoteDefinition = readActiveFootnoteDefinitionAtSelection(state, from, to);
  if (activeFootnoteDefinition) {
    return [
      {
        from: activeFootnoteDefinition.from,
        kind: "footnote-definition" as const,
        to: activeFootnoteDefinition.to,
      },
    ];
  }

  const revealRanges: RevealRangeSpec[] = [];
  const positions = new Set<number>([from]);

  if (to > from) {
    positions.add(Math.max(from, to - 1));
  }

  for (const position of positions) {
    revealRanges.push(resolveRevealRangeForPosition(state, tree, position));
  }

  return mergeRevealRanges(revealRanges);
}

function resolveRevealRangeForPosition(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree>,
  position: number,
): RevealRangeSpec {
  let candidate: { from: number; to: number } | null = null;
  let candidatePriority = -1;
  let node: SyntaxNode | null = tree.resolveInner(position, 1);

  while (node) {
    const priority = REVEAL_NODE_PRIORITIES.get(node.name);
    if (priority !== undefined && priority > candidatePriority) {
      candidate = {
        from: node.from,
        to: node.to,
      };
      candidatePriority = priority;
    }

    node = node.parent;
  }

  if (candidate) {
    return {
      ...candidate,
      kind: "selection",
    };
  }

  const line = state.doc.lineAt(position);
  return {
    from: line.from,
    kind: "selection",
    to: line.to,
  };
}

function mergeRevealRanges(ranges: RevealRangeSpec[]) {
  if (ranges.length <= 1) {
    return ranges;
  }

  const sortedRanges = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to || left.kind.localeCompare(right.kind),
  );
  // Copy instead of aliasing: merged entries are extended in place below, and
  // inputs can come from per-state caches that must never be mutated.
  const mergedRanges: RevealRangeSpec[] = [
    {
      from: sortedRanges[0].from,
      kind: sortedRanges[0].kind,
      to: sortedRanges[0].to,
    },
  ];

  for (let index = 1; index < sortedRanges.length; index += 1) {
    const currentRange = sortedRanges[index];
    const previousRange = mergedRanges[mergedRanges.length - 1];

    if (currentRange.kind === previousRange.kind && currentRange.from <= previousRange.to) {
      previousRange.to = Math.max(previousRange.to, currentRange.to);
      continue;
    }

    mergedRanges.push({
      from: currentRange.from,
      kind: currentRange.kind,
      to: currentRange.to,
    });
  }

  return mergedRanges;
}

function isMarkdownSyntaxNodeVisible(
  from: number,
  to: number,
  revealRanges: readonly RevealRangeSpec[],
) {
  for (const revealRange of revealRanges) {
    if (!rangesOverlap(from, to, revealRange.from, revealRange.to)) {
      continue;
    }

    if (revealRange.kind === "selection") {
      return false;
    }

    if (revealRange.kind === "structured-link") {
      return false;
    }

    if (revealRange.kind === "footnote-reference") {
      return true;
    }

    if (revealRange.kind === "footnote-definition") {
      return true;
    }

    if (revealRange.kind === "source-fallback") {
      return true;
    }
  }

  return false;
}

function rangesOverlap(from: number, to: number, otherFrom: number, otherTo: number) {
  return from < otherTo && to > otherFrom;
}

function getEditorViewportRangeRect(view: EditorView, from: number, to: number): EditorViewportRect | null {
  const docLength = view.state.doc.length;
  const clampedFrom = Math.max(0, Math.min(from, docLength));
  const clampedTo = Math.max(clampedFrom, Math.min(to, docLength));
  const startRect =
    view.coordsAtPos(clampedFrom, 1) ?? view.coordsAtPos(clampedFrom, -1);
  const endRect =
    view.coordsAtPos(clampedTo, -1) ??
    view.coordsAtPos(clampedTo, 1) ??
    startRect;

  if (!startRect || !endRect) {
    return null;
  }

  const left = Math.min(startRect.left, endRect.left);
  const right = Math.max(startRect.right, endRect.right);
  const top = Math.min(startRect.top, endRect.top);
  const bottom = Math.max(startRect.bottom, endRect.bottom);

  return {
    bottom,
    height: Math.max(1, bottom - top),
    left,
    right,
    top,
    width: Math.max(1, right - left),
  };
}

function getEditorPresentationMode(state: EditorState) {
  return state.field(editorPresentationModeField);
}

function isEditorCompositionActive(state: EditorState) {
  return state.field(editorCompositionStateField, false);
}

function isEditorPointerSelectionActive(state: EditorState) {
  return state.field(editorPointerSelectionStateField, false);
}

function isEditorFocusModeActive(state: EditorState) {
  return state.field(editorFocusModeField, false) === true;
}

export function buildFocusModeDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRangeSpec[],
  isFocusModeEnabled: boolean,
): DecorationSet {
  return measurePerf(
    "buildFocusModeDecorations",
    () => {
      if (!isFocusModeEnabled || visibleRanges.length === 0) {
        return Decoration.none;
      }

      const revealRanges = getRevealRangesForState(state);
      const ranges: Range<Decoration>[] = [];

      forEachVisibleLine(state, visibleRanges, (line) => {
        if (line.from === line.to) {
          return;
        }

        if (
          revealRanges.some((revealRange) =>
            rangesOverlap(line.from, line.to, revealRange.from, revealRange.to),
          )
        ) {
          return;
        }

        ranges.push(focusDimmedBlockDecoration.range(line.from, line.to));
      });

      return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
    },
    {
      docLength: state.doc.length,
      isFocusModeEnabled,
      visibleRangeCount: visibleRanges.length,
    },
  );
}

const renderedMarkdownPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomicRanges: DecorationSet;
    revealRanges: RevealRangeSpec[];

    constructor(view: EditorView) {
      this.revealRanges = getRevealRangesForState(view.state);
      const projection = buildRenderedMarkdownProjection(
        view.state,
        view.visibleRanges,
        getEditorPresentationMode(view.state),
      );
      this.decorations = projection.decorations;
      this.atomicRanges = projection.atomicRanges;
    }

    update(update: ViewUpdate) {
      const modeChanged =
        getEditorPresentationMode(update.startState) !== getEditorPresentationMode(update.state);
      const pointerSelectionChanged =
        isEditorPointerSelectionActive(update.startState) !==
        isEditorPointerSelectionActive(update.state);

      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.selectionSet ||
        modeChanged ||
        pointerSelectionChanged
      ) {
        if (
          isEditorPointerSelectionActive(update.state) &&
          !update.docChanged &&
          !update.viewportChanged &&
          !update.geometryChanged &&
          !modeChanged &&
          !pointerSelectionChanged
        ) {
          return;
        }

        if (
          update.selectionSet &&
          !update.docChanged &&
          !update.viewportChanged &&
          !update.geometryChanged &&
          !modeChanged &&
          !pointerSelectionChanged
        ) {
          const nextRevealRanges = getRevealRangesForState(update.state);
          if (revealRangesEqual(this.revealRanges, nextRevealRanges)) {
            this.revealRanges = nextRevealRanges;
            return;
          }
        }

        const projection = buildRenderedMarkdownProjection(
          update.state,
          update.view.visibleRanges,
          getEditorPresentationMode(update.state),
        );
        this.decorations = projection.decorations;
        this.atomicRanges = projection.atomicRanges;
        this.revealRanges = getRevealRangesForState(update.state);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const focusModePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    revealRanges: RevealRangeSpec[];

    constructor(view: EditorView) {
      this.revealRanges = getRevealRangesForState(view.state);
      this.decorations = buildFocusModeDecorations(
        view.state,
        view.visibleRanges,
        isEditorFocusModeActive(view.state),
      );
    }

    update(update: ViewUpdate) {
      const focusModeChanged =
        isEditorFocusModeActive(update.startState) !== isEditorFocusModeActive(update.state);

      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.selectionSet ||
        focusModeChanged
      ) {
        if (
          update.selectionSet &&
          !update.docChanged &&
          !update.viewportChanged &&
          !update.geometryChanged &&
          !focusModeChanged
        ) {
          const nextRevealRanges = getRevealRangesForState(update.state);
          if (revealRangesEqual(this.revealRanges, nextRevealRanges)) {
            this.revealRanges = nextRevealRanges;
            return;
          }
        }

        this.decorations = buildFocusModeDecorations(
          update.state,
          update.view.visibleRanges,
          isEditorFocusModeActive(update.state),
        );
        this.revealRanges = getRevealRangesForState(update.state);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

export const markdownHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ],
    color: "var(--editor-ink)",
    fontFamily: "var(--font-display)",
    fontWeight: "400",
    letterSpacing: "-0.015em",
    textDecoration: "none",
  },
  {
    tag: tags.heading1,
    fontSize: "30px",
    lineHeight: "1.25",
  },
  {
    tag: tags.heading2,
    fontSize: "24px",
    lineHeight: "1.3",
    letterSpacing: "-0.01em",
  },
  {
    tag: tags.heading3,
    fontSize: "20px",
    lineHeight: "1.4",
    letterSpacing: "0",
  },
  {
    tag: tags.heading4,
    fontFamily: "var(--font-body)",
    fontSize: "17px",
    fontWeight: "600",
    lineHeight: "1.75",
    letterSpacing: "0",
  },
  {
    tag: tags.heading5,
    fontFamily: "var(--font-body)",
    fontSize: "15px",
    fontWeight: "600",
    lineHeight: "1.75",
    letterSpacing: "0",
  },
  {
    tag: tags.heading6,
    fontFamily: "var(--font-body)",
    fontSize: "13px",
    fontWeight: "500",
    lineHeight: "1.75",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--accent)",
  },
  {
    tag: tags.processingInstruction,
    color: "var(--editor-syntax-faded)",
  },
  {
    tag: tags.quote,
    color: "var(--editor-quote-ink)",
    fontStyle: "italic",
  },
  {
    tag: tags.link,
    color: "var(--accent-link)",
    textDecoration: "underline",
    textDecorationColor: "var(--editor-anchor-active-underline)",
    textUnderlineOffset: "0.12em",
  },
  {
    tag: tags.url,
    color: "var(--accent-link)",
  },
  {
    tag: tags.emphasis,
    fontStyle: "italic",
  },
  {
    tag: tags.strong,
    fontWeight: "700",
  },
  {
    tag: tags.labelName,
    color: "var(--editor-ink-tertiary)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.86em",
  },
  {
    tag: tags.contentSeparator,
    color: "var(--editor-syntax-faded)",
  },
  {
    tag: tags.monospace,
    color: "var(--editor-code-ink)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
  },
]);

const margentReadableTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--editor-ink)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-body)",
    fontSize: "17px",
    fontVariantNumeric: "lining-nums",
    lineHeight: "1.75",
  },
  ".cm-content": {
    minHeight: "100%",
    caretColor: "var(--editor-caret)",
  },
  ".cm-line": {
    position: "relative",
    maxWidth: "calc(112ch + 64px)",
    margin: "0 auto",
    padding: "0 56px 0 8px",
  },
  ".cm-gutters": {
    border: "0",
    backgroundColor: "var(--editor-gutter-bg)",
    color: "var(--editor-gutter-ink)",
    paddingRight: "10px",
  },
  ".cm-gutterElement": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.8rem",
  },
  "&.cm-focused.cm-raw-mode .cm-activeLine, &.cm-focused.cm-raw-mode .cm-activeLineGutter": {
    backgroundColor: "var(--editor-active-line)",
  },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--editor-selection) !important",
  },
  ".cm-md-blockquote": {
    borderLeft: "2px solid var(--editor-quote-rule)",
    color: "var(--editor-quote-ink)",
    paddingLeft: "18px",
  },
  ".cm-md-list": {
    paddingLeft: "14px",
  },
  ".cm-md-hr": {
    backgroundImage:
      "linear-gradient(180deg, transparent calc(50% - 1px), var(--rule-cream) 50%, transparent calc(50% + 1px))",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "8px center",
    color: "var(--editor-syntax-faded)",
  },
  ".cm-md-code-fence": {
    color: "var(--editor-ink-tertiary)",
  },
  ".cm-md-code-block-line": {
    backgroundColor: "var(--editor-code-wash)",
    color: "var(--editor-code-ink)",
    fontFamily: "var(--font-mono)",
    fontSize: "13.5px",
    lineHeight: "1.7",
  },
  ".cm-md-code-block-start": {
    borderTopLeftRadius: "5px",
    borderTopRightRadius: "5px",
    color: "var(--editor-ink-tertiary)",
  },
  ".cm-md-code-block-content": {
    boxShadow: "inset 2px 0 0 var(--rule-cream)",
  },
  ".cm-md-code-block-end": {
    borderBottomLeftRadius: "5px",
    borderBottomRightRadius: "5px",
    color: "var(--editor-syntax-faded)",
  },
  ".cm-md-code-language-widget": {
    display: "inline-flex",
    alignItems: "center",
    minWidth: "0",
    border: "1px solid var(--rule-cream)",
    borderRadius: "4px",
    backgroundColor: "var(--editor-panel-wash)",
    color: "var(--editor-ink-secondary)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    fontWeight: "700",
    lineHeight: "1.35",
    padding: "0 0.42rem",
    textTransform: "uppercase",
  },
  ".cm-md-frontmatter": {
    backgroundColor: "var(--editor-panel-wash)",
    color: "var(--editor-ink-tertiary)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.82em",
  },
  ".cm-md-frontmatter-start": {
    borderTopLeftRadius: "5px",
    borderTopRightRadius: "5px",
  },
  ".cm-md-frontmatter-end": {
    borderBottomLeftRadius: "5px",
    borderBottomRightRadius: "5px",
  },
  ".cm-md-frontmatter-content": {
    boxShadow: "inset 2px 0 0 var(--rule-cream)",
  },
  ".cm-md-footnote-ref": {
    display: "inline-block",
    verticalAlign: "super",
    marginLeft: "0.08em",
    color: "var(--accent-link)",
    fontSize: "0.72em",
    fontWeight: "700",
    lineHeight: "1",
  },
  ".cm-md-list-marker-widget": {
    display: "inline-block",
    minWidth: "1.1em",
    marginRight: "0.2em",
    color: "var(--editor-ink-secondary)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: "600",
  },
  ".cm-md-list-marker-widget-ordered": {
    minWidth: "1.6em",
  },
  ".cm-md-task-checkbox-widget": {
    width: "0.92em",
    height: "0.92em",
    margin: "0 0.36em 0 0",
    verticalAlign: "-0.08em",
    accentColor: "var(--accent-link)",
  },
  ".cm-md-image-block": {
    display: "block",
    boxSizing: "border-box",
    maxWidth: "min(calc(68ch + 64px), calc(100% - 24px))",
    margin: "12px auto",
    padding: "10px",
    border: "1px solid var(--rule-cream)",
    borderRadius: "5px",
    backgroundColor: "var(--editor-panel-wash)",
    cursor: "text",
  },
  ".cm-md-image-block img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "60vh",
    margin: "0 auto",
    objectFit: "contain",
  },
  ".cm-md-image-caption": {
    marginTop: "8px",
    color: "var(--editor-ink-tertiary)",
    fontFamily: "var(--font-body)",
    fontSize: "0.82em",
    lineHeight: "1.35",
    textAlign: "center",
  },
  ".cm-md-table-block": {
    display: "block",
    boxSizing: "border-box",
    width: "min(100%, calc(112ch + 64px))",
    maxHeight: "48vh",
    margin: "12px 0",
    overflow: "auto",
    border: "1px solid var(--rule-cream)",
    borderRadius: "5px",
    backgroundColor: "var(--editor-panel-wash)",
    cursor: "text",
  },
  ".cm-md-table-block table": {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: "var(--font-body)",
    fontSize: "0.9em",
    lineHeight: "1.4",
    tableLayout: "fixed",
  },
  ".cm-md-table-block th, .cm-md-table-block td": {
    border: "1px solid var(--rule-cream)",
    padding: "8px 10px",
    verticalAlign: "top",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  ".cm-md-table-block th": {
    backgroundColor: "rgba(255, 255, 255, 0.55)",
    color: "var(--editor-ink)",
    fontWeight: "700",
  },
  ".cm-md-table-block td": {
    color: "var(--editor-ink-secondary)",
  },
  ".cm-md-table-line": {
    backgroundColor: "var(--editor-panel-wash)",
    borderLeft: "1px solid var(--rule-cream)",
    borderRight: "1px solid var(--rule-cream)",
    color: "var(--editor-code-ink)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    lineHeight: "1.65",
    minWidth: "max-content",
    paddingLeft: "12px",
    paddingRight: "12px",
    whiteSpace: "pre",
  },
  ".cm-md-table-header": {
    borderTop: "1px solid var(--rule-cream)",
    fontWeight: "500",
    marginTop: "10px",
    paddingTop: "8px",
  },
  ".cm-md-table-divider, .cm-md-table-syntax": {
    color: "var(--editor-syntax-faded)",
  },
  ".cm-md-table-last": {
    borderBottom: "1px solid var(--rule-cream)",
    marginBottom: "10px",
    paddingBottom: "8px",
  },
  ".cm-md-footnote-definition": {
    color: "var(--editor-ink-secondary)",
    paddingLeft: "18px",
  },
  ".cm-thread-anchor": {
    backgroundColor: "var(--editor-anchor-wash)",
    borderRadius: "4px",
    boxShadow: "inset 0 -1px 0 var(--editor-anchor-underline)",
  },
  ".cm-thread-anchor:hover": {
    backgroundColor: "var(--editor-anchor-hover-wash)",
  },
  ".cm-thread-anchor.is-active": {
    backgroundColor: "var(--editor-anchor-active-wash)",
    boxShadow: "inset 0 -1px 0 var(--editor-anchor-active-underline)",
  },
  ".cm-thread-marker": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    position: "absolute",
    width: "20px",
    height: "20px",
    marginLeft: "0",
    border: "1px solid var(--editor-marker-border)",
    borderRadius: "999px",
    background: "var(--editor-marker-bg)",
    color: "var(--editor-marker-ink)",
    fontSize: "11px",
    fontWeight: "700",
    cursor: "pointer",
    verticalAlign: "middle",
    zIndex: "1",
  },
  ".cm-thread-marker.is-active": {
    borderColor: "var(--editor-marker-active-border)",
    background: "var(--editor-marker-active-bg)",
    color: "var(--editor-marker-active-ink)",
  },
  ".cm-thread-marker:hover:not(.is-active)": {
    borderColor: "var(--editor-marker-hover-border)",
    background: "var(--editor-marker-hover-bg)",
    color: "var(--editor-marker-hover-ink)",
  },
  ".cm-thread-marker.is-group": {
    width: "24px",
    borderRadius: "999px",
    fontSize: "10px",
  },
  ".cm-thread-marker.is-fuzzy, .cm-thread-marker.is-needs-review": {
    borderColor: "var(--editor-marker-border)",
    color: "var(--editor-marker-ink)",
  },
  ".cm-thread-anchor.is-fuzzy": {
    backgroundColor: "var(--editor-anchor-wash)",
  },
  ".cm-thread-anchor.is-needs-review": {
    backgroundColor: "var(--editor-anchor-wash)",
    boxShadow: "inset 0 -1px 0 var(--editor-anchor-underline)",
  },
  ".cm-thread-anchor:has(.cm-proposal-inline-revision), .cm-thread-anchor.is-active:has(.cm-proposal-inline-revision)": {
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  ".cm-proposal-inline-revision": {
    borderRadius: "3px",
    cursor: "pointer",
    whiteSpace: "pre-wrap",
  },
  ".cm-proposal-inline-revision.is-block": {
    display: "block",
    lineHeight: "1.58",
    padding: "2px 0",
  },
  ".cm-proposal-inline-revision.is-active": {
    boxShadow: "0 0 0 1px rgba(13, 72, 69, 0.12)",
  },
  ".cm-proposal-inline-revision.is-excluded": {
    opacity: "0.5",
  },
  ".cm-proposal-inline-content": {
    whiteSpace: "pre-wrap",
  },
  ".cm-proposal-inline-token": {
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-proposal-inline-token.is-delete": {
    backgroundColor: "rgba(180, 35, 24, 0.09)",
    color: "#9f2a20",
    textDecoration: "line-through",
    textDecorationColor: "rgba(180, 35, 24, 0.58)",
  },
  ".cm-proposal-inline-token.is-insert": {
    backgroundColor: "rgba(52, 118, 70, 0.12)",
    color: "#237044",
    boxShadow: "inset 0 -1px 0 rgba(52, 118, 70, 0.42)",
  },
  ".cm-proposal-inline-token.is-replace": {
    backgroundColor: "rgba(52, 118, 70, 0.12)",
    boxShadow: "inset 0 -1px 0 rgba(52, 118, 70, 0.42)",
    color: "#237044",
  },
  ".cm-proposal-inline-chip": {
    alignItems: "center",
    border: "1px solid var(--editor-marker-active-border)",
    borderRadius: "999px",
    background: "var(--editor-marker-active-bg)",
    color: "var(--editor-marker-active-ink)",
    cursor: "pointer",
    display: "inline-flex",
    font: "inherit",
    fontSize: "10px",
    fontWeight: "700",
    height: "17px",
    justifyContent: "center",
    lineHeight: "1",
    marginLeft: "5px",
    minWidth: "17px",
    padding: "0 5px",
    position: "relative",
    top: "-1px",
    verticalAlign: "middle",
  },
  ".cm-proposal-inline-chip:hover": {
    borderColor: "var(--editor-marker-hover-border)",
    background: "var(--editor-marker-hover-bg)",
    color: "var(--editor-marker-hover-ink)",
  },
  "&.cm-rendered-mode .cm-gutters": {
    backgroundColor: "var(--editor-gutter-bg)",
    color: "var(--editor-syntax-faded)",
  },
  "&.cm-rendered-mode .cm-line": {
    color: "var(--editor-line-ink)",
  },
  ".cm-md-emphasis-content": {
    fontStyle: "italic",
  },
  ".cm-md-strong-content": {
    fontWeight: "700",
  },
  ".cm-md-loose-local-link-label": {
    color: "var(--accent-link)",
    textDecoration: "underline",
    textDecorationColor: "var(--editor-anchor-active-underline)",
    textUnderlineOffset: "0.12em",
  },
  ".cm-md-wikilink-label": {
    borderBottom: "1px dotted var(--editor-anchor-active-underline)",
    color: "var(--accent-link)",
    fontWeight: "600",
  },
  ".cm-focused": {
    outline: "none",
  },
  ".cm-md-syntax-hidden": {
    display: "none",
  },
  ".cm-focus-dimmed-block": {
    color: "var(--editor-focus-muted-ink)",
  },
});

const baseExtensions = [
  editorGutterCompartment.of(editorGutterExtensionsForMode("raw")),
  highlightActiveLine(),
  drawSelection(),
  history(),
  EditorState.allowMultipleSelections.of(true),
  EditorView.lineWrapping,
  search({ top: true }),
  keymap.of([...searchKeymap, indentWithTab, ...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
  markdown({ codeLanguages: markdownCodeLanguages }),
  syntaxHighlighting(defaultHighlightStyle),
  syntaxHighlighting(markdownHighlightStyle),
  editorPresentationModeField,
  editorFocusModeField,
  editorCompositionStateField,
  editorPointerSelectionStateField,
  renderedMarkdownPlugin,
  focusModePlugin,
  EditorView.atomicRanges.of(
    (view) => view.plugin(renderedMarkdownPlugin)?.atomicRanges ?? Decoration.none,
  ),
  margentReadableTheme,
];

// --- Thread decoration StateField ---
// Decorations map through document changes automatically (no per-keystroke re-resolution).
// Full re-resolution only happens when threads change or the document is externally replaced.

const replaceThreadPresentation = StateEffect.define<ThreadPresentation>();
const replaceThreadDecorations = StateEffect.define<RangeSet<Decoration>>();

const emptyThreadPresentation: ThreadPresentation = {
  placements: [],
  rangesByThreadId: new Map(),
};

const threadPresentationField = StateField.define<ThreadPresentation>({
  create() {
    return emptyThreadPresentation;
  },
  update(threadPresentation, tr) {
    if (tr.docChanged) {
      threadPresentation = mapThreadPresentation(threadPresentation, tr.changes);
    }

    for (const effect of tr.effects) {
      if (effect.is(replaceThreadPresentation)) {
        threadPresentation = effect.value;
      }
    }

    return threadPresentation;
  },
});

const threadDecorationsField = StateField.define<RangeSet<Decoration>>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(replaceThreadDecorations)) {
        decorations = effect.value;
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function useCodeMirror({
  editorMode = "raw",
  initialValue,
  isFocusModeEnabled = false,
  onActiveFootnoteDefinitionChange,
  onActiveLinkChange,
  onCreateLinkRequested,
  onFocusModeTypingActivity,
  onImportImageAsset,
  onSaveRequested,
  onSelectionChange,
  onThreadSelect,
  proposalReview = null,
  resolveMarkdownImageSource,
  selectedThreadId = null,
  threads = [],
}: UseCodeMirrorOptions) {
  const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
  const initialSessionSnapshot = createInitialSessionSnapshot();
  const initialSessionMetrics = createSessionMetricsFromContent(initialValue);
  const [sessionSnapshot, setSessionSnapshot] = useState<CodeMirrorSessionSnapshot>(
    initialSessionSnapshot,
  );
  const [sessionMetrics, setSessionMetrics] =
    useState<CodeMirrorSessionMetrics>(initialSessionMetrics);
  const viewRef = useRef<EditorView | null>(null);
  const onActiveFootnoteDefinitionChangeRef = useRef(onActiveFootnoteDefinitionChange);
  const onActiveLinkChangeRef = useRef(onActiveLinkChange);
  const onCreateLinkRequestedRef = useRef(onCreateLinkRequested);
  const onFocusModeTypingActivityRef = useRef(onFocusModeTypingActivity);
  const onImportImageAssetRef = useRef(onImportImageAsset);
  const onSaveRequestedRef = useRef(onSaveRequested);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onThreadSelectRef = useRef<UseCodeMirrorOptions["onThreadSelect"]>(undefined);
  const resolveMarkdownImageSourceRef = useRef(resolveMarkdownImageSource);
  const revisionRef = useRef(0);
  const cleanRevisionRef = useRef(0);
  const sessionSnapshotRef = useRef<CodeMirrorSessionSnapshot>(initialSessionSnapshot);
  const sessionMetricsRef = useRef<CodeMirrorSessionMetrics>(initialSessionMetrics);
  const activeFootnoteDefinitionRef = useRef<ActiveFootnoteDefinition | null>(null);
  const activeLinkRef = useRef<ActiveMarkdownLink | null>(null);
  const selectionSnapshotRef = useRef<EditorSelectionSnapshot | null>(null);
  const pendingFocusModeScrollFrameRef = useRef<number | null>(null);
  const pendingSessionSnapshotFrameRef = useRef<number | null>(null);
  const pendingSessionMetricsTimeoutRef = useRef<number | null>(null);
  const suppressNextRevisionIncrementRef = useRef(false);
  const proposalReviewRef = useRef<ProposalReviewEditorState | null>(proposalReview);
  const threadsRef = useRef(threads);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const editorModeRef = useRef<EditorMode>(editorMode);
  const focusModeRef = useRef(isFocusModeEnabled);
  const sessionRef = useRef<CodeMirrorSession | null>(null);

  useEffect(() => {
    onActiveFootnoteDefinitionChangeRef.current = onActiveFootnoteDefinitionChange;
  }, [onActiveFootnoteDefinitionChange]);

  useEffect(() => {
    onActiveLinkChangeRef.current = onActiveLinkChange;
  }, [onActiveLinkChange]);

  useEffect(() => {
    onCreateLinkRequestedRef.current = onCreateLinkRequested;
  }, [onCreateLinkRequested]);

  useEffect(() => {
    onFocusModeTypingActivityRef.current = onFocusModeTypingActivity;
  }, [onFocusModeTypingActivity]);

  useEffect(() => {
    onImportImageAssetRef.current = onImportImageAsset;
  }, [onImportImageAsset]);

  useEffect(() => {
    onSaveRequestedRef.current = onSaveRequested;
  }, [onSaveRequested]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onThreadSelectRef.current = onThreadSelect;
  }, [onThreadSelect]);

  useEffect(() => {
    const previousActiveHunkId = proposalReviewRef.current?.activeHunkId ?? null;
    proposalReviewRef.current = proposalReview;
    const view = viewRef.current;
    if (!view) {
      return;
    }

    applyProposalReviewState(view, proposalReview);

    const nextActiveHunkId = proposalReview?.activeHunkId ?? null;
    if (nextActiveHunkId && nextActiveHunkId !== previousActiveHunkId) {
      const activeHunk = proposalReview?.changeSet.hunks.find(
        (hunk) => hunk.id === nextActiveHunkId,
      );
      const activePosition = activeHunk ? getProposalHunkAnchorPosition(view.state, activeHunk) : null;
      if (activePosition !== null) {
        view.dispatch({
          effects: EditorView.scrollIntoView(activePosition, {
            y: "center",
            yMargin: 96,
          }),
        });
      }
    }
  }, [proposalReview]);

  useEffect(() => {
    resolveMarkdownImageSourceRef.current = resolveMarkdownImageSource;
  }, [resolveMarkdownImageSource]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    editorModeRef.current = editorMode;
  }, [editorMode]);

  useEffect(() => {
    focusModeRef.current = isFocusModeEnabled;
  }, [isFocusModeEnabled]);

  function updateSessionSnapshot(state: EditorState) {
    setSessionSnapshot((current) => {
      const nextSnapshot = createSessionSnapshot(
        state,
        revisionRef.current,
        cleanRevisionRef.current,
      );

      if (current.isDirty === nextSnapshot.isDirty && current.revision === nextSnapshot.revision) {
        sessionSnapshotRef.current = current;
        return current;
      }

      sessionSnapshotRef.current = nextSnapshot;
      return nextSnapshot;
    });
  }

  function updateSessionMetrics(state: EditorState) {
    setSessionMetrics((current) => {
      const nextMetrics = createSessionMetricsFromState(state);

      if (
        current.characterCount === nextMetrics.characterCount &&
        current.lineCount === nextMetrics.lineCount
      ) {
        sessionMetricsRef.current = current;
        return current;
      }

      sessionMetricsRef.current = nextMetrics;
      return nextMetrics;
    });
  }

  function scheduleSessionSnapshotUpdate() {
    if (pendingSessionSnapshotFrameRef.current !== null) {
      return;
    }

    pendingSessionSnapshotFrameRef.current = window.requestAnimationFrame(() => {
      pendingSessionSnapshotFrameRef.current = null;
      const view = viewRef.current;
      if (!view) {
        return;
      }

      updateSessionSnapshot(view.state);
    });
  }

  function scheduleSessionMetricsUpdate() {
    if (pendingSessionMetricsTimeoutRef.current !== null) {
      window.clearTimeout(pendingSessionMetricsTimeoutRef.current);
    }

    pendingSessionMetricsTimeoutRef.current = window.setTimeout(() => {
      pendingSessionMetricsTimeoutRef.current = null;
      const view = viewRef.current;
      if (!view) {
        return;
      }

      updateSessionMetrics(view.state);
    }, SESSION_METRICS_UPDATE_DELAY_MS);
  }

  function scheduleFocusModeCentering() {
    if (pendingFocusModeScrollFrameRef.current !== null) {
      return;
    }

    pendingFocusModeScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingFocusModeScrollFrameRef.current = null;
      const view = viewRef.current;
      if (
        !view ||
        !isEditorFocusModeActive(view.state) ||
        isEditorCompositionActive(view.state) ||
        isEditorPointerSelectionActive(view.state)
      ) {
        return;
      }

      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, {
          y: "center",
        }),
      });
    });
  }

  function cancelPendingSessionUpdates() {
    if (pendingFocusModeScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFocusModeScrollFrameRef.current);
      pendingFocusModeScrollFrameRef.current = null;
    }

    if (pendingSessionSnapshotFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingSessionSnapshotFrameRef.current);
      pendingSessionSnapshotFrameRef.current = null;
    }

    if (pendingSessionMetricsTimeoutRef.current !== null) {
      window.clearTimeout(pendingSessionMetricsTimeoutRef.current);
      pendingSessionMetricsTimeoutRef.current = null;
    }
  }

  if (!sessionRef.current) {
    sessionRef.current = {
      createMarkdownLink(selection, nextValues) {
        const view = viewRef.current;
        const normalizedUrl = nextValues.url.trim();
        if (!view || !normalizedUrl) {
          return;
        }

        const from = Math.max(0, Math.min(selection.startOffsetUtf16, view.state.doc.length));
        const to = Math.max(from, Math.min(selection.endOffsetUtf16, view.state.doc.length));
        const currentSelectionText = view.state.doc.sliceString(from, to);
        const label = nextValues.label || currentSelectionText || selection.quote;
        if (!label) {
          return;
        }

        const replacement = buildMarkdownLinkReplacement({
          label,
          title: nextValues.title,
          url: normalizedUrl,
        });
        view.dispatch({
          changes: {
            from,
            insert: replacement,
            to,
          },
          selection: {
            anchor: from + replacement.length,
          },
        });
      },
      focus() {
        viewRef.current?.focus();
      },
      focusFootnoteDefinition(footnoteDefinition) {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        view.dispatch({
          selection: {
            anchor: footnoteDefinition.from,
            head: footnoteDefinition.to,
          },
        });
        view.focus();
      },
      getCharacterCount() {
        return viewRef.current?.state.doc.length ?? sessionMetricsRef.current.characterCount;
      },
      getContent() {
        return viewRef.current?.state.doc.toString() ?? initialValue;
      },
      getRangeRect(from, to) {
        const view = viewRef.current;
        if (!view) {
          return null;
        }

        return getEditorViewportRangeRect(view, from, to);
      },
      getLineCount() {
        return viewRef.current?.state.doc.lines ?? sessionMetricsRef.current.lineCount;
      },
      getRevision() {
        return revisionRef.current;
      },
      getSelectionSnapshot() {
        return selectionSnapshotRef.current;
      },
      isDirty() {
        return revisionRef.current !== cleanRevisionRef.current;
      },
      markClean() {
        cleanRevisionRef.current = revisionRef.current;
        if (viewRef.current) {
          cancelPendingSessionUpdates();
          updateSessionSnapshot(viewRef.current.state);
          updateSessionMetrics(viewRef.current.state);
        } else {
          setSessionSnapshot((current) => {
            const nextSnapshot = {
              ...current,
              isDirty: false,
              revision: cleanRevisionRef.current,
            };
            sessionSnapshotRef.current = nextSnapshot;
            return nextSnapshot;
          });
        }
      },
      openSearch() {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        openSearchPanel(view);
        view.focus();
      },
      scrollToLine(lineNumber) {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        const clampedLineNumber = Math.max(
          1,
          Math.min(Math.floor(lineNumber), view.state.doc.lines),
        );
        const line = view.state.doc.line(clampedLineNumber);
        view.dispatch({
          effects: EditorView.scrollIntoView(line.from, {
            y: "center",
          }),
          selection: {
            anchor: line.from,
          },
        });
        view.focus();
      },
      removeMarkdownLink(link) {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        const replacement = link.label;
        view.dispatch({
          changes: {
            from: link.from,
            insert: replacement,
            to: link.to,
          },
          selection: {
            anchor: link.from + replacement.length,
          },
        });
      },
      replaceContent(nextContent: string, options = {}) {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        const currentContent = view.state.doc.toString();
        if (currentContent === nextContent) {
          cleanRevisionRef.current = revisionRef.current;
          updateSessionSnapshot(view.state);
          return;
        }

        revisionRef.current += 1;
        cleanRevisionRef.current = revisionRef.current;
        suppressNextRevisionIncrementRef.current = true;
        cancelPendingSessionUpdates();
        const preserveViewport = options.preserveViewport === true;
        const scrollTop = view.scrollDOM.scrollTop;
        const scrollLeft = view.scrollDOM.scrollLeft;
        const selection = view.state.selection.main;
        const nextSelection = preserveViewport
          ? EditorSelection.range(
              Math.min(selection.anchor, nextContent.length),
              Math.min(selection.head, nextContent.length),
            )
          : undefined;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: nextContent,
          },
          effects: preserveViewport ? view.scrollSnapshot() : undefined,
          selection: nextSelection,
        });
        if (preserveViewport) {
          restoreEditorScroll(view, scrollTop, scrollLeft);
        }

        const nextThreadPresentation = buildThreadPresentation(threadsRef.current, view.state);
        applyThreadPresentation(view, nextThreadPresentation, selectedThreadIdRef.current);
      },
      updateFootnoteDefinition(footnoteDefinition, nextValues) {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        const normalizedLabel = nextValues.label.trim();
        if (!normalizedLabel) {
          return;
        }

        const replacement = buildMarkdownFootnoteDefinitionReplacement({
          content: nextValues.content,
          label: normalizedLabel,
        });
        const selectionAnchor = footnoteDefinition.from + replacement.length;
        view.dispatch({
          changes: {
            from: footnoteDefinition.from,
            insert: replacement,
            to: footnoteDefinition.to,
          },
          selection: {
            anchor: selectionAnchor,
          },
        });
      },
      updateMarkdownLink(link, nextValues) {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        const replacement = buildMarkdownLinkReplacement(nextValues);
        view.dispatch({
          changes: {
            from: link.from,
            insert: replacement,
            to: link.to,
          },
          selection: {
            anchor: link.from + replacement.length,
          },
        });
      },
    };
  }

  // --- Editor creation ---
  useEffect(() => {
    if (!hostElement || viewRef.current) {
      return;
    }

	    const view = new EditorView({
	      parent: hostElement,
	      state: EditorState.create({
	        doc: initialValue,
	        extensions: [
          ...baseExtensions,
          markdownImageSourceResolverFacet.of(
            (source) => resolveMarkdownImageSourceRef.current?.(source) ?? source,
          ),
		          Prec.highest(keymap.of([
		            {
		              key: "Mod-b",
		              preventDefault: true,
		              run(currentView) {
	                return toggleMarkdownInlineStyle(currentView, "**");
	              },
	            },
	            {
	              key: "Mod-i",
	              preventDefault: true,
	              run(currentView) {
	                return toggleMarkdownInlineStyle(currentView, "*");
	              },
	            },
	            {
	              key: "Mod-k",
	              preventDefault: true,
	              run(currentView) {
	                const activeLink = readActiveMarkdownLink(currentView.state);
	                if (activeLink) {
	                  onActiveLinkChangeRef.current?.(activeLink);
	                  return true;
	                }

	                const selection = readSelection(currentView.state);
	                if (!selection) {
	                  return false;
	                }

	                onCreateLinkRequestedRef.current?.(selection);
	                return true;
	              },
	            },
	            {
	              key: "Mod-s",
	              preventDefault: true,
	              run(currentView) {
	                onSaveRequestedRef.current?.(currentView.state.doc.toString());
		                return true;
		              },
		            },
		          ])),
	          editorPresentationModeField.init(() => editorModeRef.current),
	          editorFocusModeField.init(() => focusModeRef.current),
          pendingImageInsertionRangeField,
	          threadPresentationField,
	          threadDecorationsField,
          proposalReviewDecorationsField,
          layer({
            above: true,
            class: "cm-thread-marker-layer",
            update(update) {
              return (
                update.docChanged ||
                update.viewportChanged ||
                update.geometryChanged ||
                update.transactions.some((transaction) =>
                  transaction.effects.some((effect) => effect.is(replaceThreadPresentation)),
                )
              );
            },
            markers(layerView) {
              return buildThreadLayerMarkers(
                layerView,
                getThreadPresentation(layerView.state),
                selectedThreadIdRef.current,
                onThreadSelectRef.current,
              );
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              if (suppressNextRevisionIncrementRef.current) {
                suppressNextRevisionIncrementRef.current = false;
              } else {
                revisionRef.current += 1;
              }

              scheduleSessionSnapshotUpdate();
              scheduleSessionMetricsUpdate();

              if (
                isEditorFocusModeActive(update.state) &&
                !isEditorCompositionActive(update.state) &&
                !isEditorPointerSelectionActive(update.state)
              ) {
                onFocusModeTypingActivityRef.current?.();
                scheduleFocusModeCentering();
              }
            }

            if (update.docChanged || update.selectionSet) {
              const selection = readSelection(update.state);
              if (!areSelectionsEqual(selectionSnapshotRef.current, selection)) {
                selectionSnapshotRef.current = selection;
                onSelectionChangeRef.current?.(selection);
              }

              const activeFootnoteDefinition = readActiveFootnoteDefinition(update.state);
              if (
                !areActiveFootnoteDefinitionsEqual(
                  activeFootnoteDefinitionRef.current,
                  activeFootnoteDefinition,
                )
              ) {
                activeFootnoteDefinitionRef.current = activeFootnoteDefinition;
                onActiveFootnoteDefinitionChangeRef.current?.(activeFootnoteDefinition);
              }

              const activeLink = readActiveMarkdownLink(update.state);
              if (!areActiveMarkdownLinksEqual(activeLinkRef.current, activeLink)) {
                activeLinkRef.current = activeLink;
                onActiveLinkChangeRef.current?.(activeLink);
              }
            }
          }),
          EditorView.domEventHandlers({
            blur: () => {
              const view = viewRef.current;
              if (!view || !isEditorCompositionActive(view.state)) {
                return false;
              }

              view.dispatch({
                effects: setEditorCompositionState.of(false),
              });
              return false;
            },
            compositionend: () => {
              const view = viewRef.current;
              if (!view || !isEditorCompositionActive(view.state)) {
                return false;
              }

              view.dispatch({
                effects: setEditorCompositionState.of(false),
              });
              return false;
            },
            compositionstart: () => {
              const view = viewRef.current;
              if (!view || isEditorCompositionActive(view.state)) {
                return false;
              }

              view.dispatch({
                effects: setEditorCompositionState.of(true),
              });
              return false;
            },
            mousedown: (event) => {
              const target = event.target;
              if (!(target instanceof Element)) {
                return false;
              }

              if (target.closest(".cm-proposal-inline-revision")) {
                event.preventDefault();
                return true;
              }

              const view = viewRef.current;
              const clickedLink =
                view && getEditorPresentationMode(view.state) === "rendered"
                  ? readMarkdownLinkAtMouseEvent(view, event)
                  : null;
              if (clickedLink) {
                activeLinkRef.current = clickedLink;
                onActiveLinkChangeRef.current?.(clickedLink);
              }

              const threadElement = target.closest<HTMLElement>('[data-thread-role="marker"]');
              const threadIds =
                threadElement?.dataset.threadIds
                  ?.split(" ")
                  .map((threadId) => threadId.trim())
                  .filter(Boolean) ?? [];

              if (!threadIds.length) {
                if (
                  view &&
                  event.button === 0 &&
                  target.closest(".cm-content") &&
                  !isEditorPointerSelectionActive(view.state)
                ) {
                  view.dispatch({
                    effects: setEditorPointerSelectionState.of(true),
                  });

                  const finishPointerSelection = () => {
                    window.removeEventListener("mouseup", finishPointerSelection);
                    window.removeEventListener("blur", finishPointerSelection);
                    const currentView = viewRef.current;
                    if (!currentView || !isEditorPointerSelectionActive(currentView.state)) {
                      return;
                    }

                    currentView.dispatch({
                      effects: setEditorPointerSelectionState.of(false),
                    });
                  };

                  window.addEventListener("mouseup", finishPointerSelection);
                  window.addEventListener("blur", finishPointerSelection);
                }

                return false;
              }

              event.preventDefault();
              onThreadSelectRef.current?.(
                getNextSelectedThreadId(threadIds, selectedThreadIdRef.current),
              );
              return true;
            },
            paste: (event, currentView) => {
              const imageFile = getFirstSupportedImageFile(event.clipboardData);
              const importImageAsset = onImportImageAssetRef.current;
              if (imageFile && importImageAsset) {
                event.preventDefault();
                void importImageFileAtSelection(currentView, imageFile, importImageAsset).catch(
                  () => undefined,
                );
                return true;
              }

              const html = event.clipboardData?.getData("text/html") ?? "";
              if (!html.trim()) {
                return false;
              }

              const plainText = event.clipboardData?.getData("text/plain") ?? "";
              const markdownText = convertClipboardHtmlToMarkdown(html, plainText);
              if (!markdownText.trim()) {
                return false;
              }

              event.preventDefault();
              currentView.dispatch(currentView.state.replaceSelection(markdownText));
              return true;
            },
            dragover: (event) => {
              if (!getFirstSupportedImageFile(event.dataTransfer) || !onImportImageAssetRef.current) {
                return false;
              }

              event.preventDefault();
              if (event.dataTransfer) {
                event.dataTransfer.dropEffect = "copy";
              }
              return true;
            },
            drop: (event, currentView) => {
              const imageFile = getFirstSupportedImageFile(event.dataTransfer);
              const importImageAsset = onImportImageAssetRef.current;
              if (!imageFile || !importImageAsset) {
                return false;
              }

              event.preventDefault();
              const position =
                safePosAtCoords(currentView, {
                  x: event.clientX,
                  y: event.clientY,
                }) ?? currentView.state.selection.main.head;
              void importImageFileAtSelection(
                currentView,
                imageFile,
                importImageAsset,
                position,
              ).catch(() => undefined);
              return true;
            },
          }),
        ],
      }),
    });

    viewRef.current = view;
    view.dom.classList.toggle("cm-rendered-mode", editorModeRef.current === "rendered");
    view.dom.classList.toggle("cm-raw-mode", editorModeRef.current !== "rendered");
    view.dom.classList.toggle("cm-focus-mode", focusModeRef.current);
    view.dispatch({
      effects: [
        setEditorPresentationMode.of(editorModeRef.current),
        setEditorFocusMode.of(focusModeRef.current),
        editorGutterCompartment.reconfigure(editorGutterExtensionsForMode(editorModeRef.current)),
      ],
    });
    activeLinkRef.current = readActiveMarkdownLink(view.state);
    onActiveLinkChangeRef.current?.(activeLinkRef.current);
    activeFootnoteDefinitionRef.current = readActiveFootnoteDefinition(view.state);
    onActiveFootnoteDefinitionChangeRef.current?.(activeFootnoteDefinitionRef.current);
    selectionSnapshotRef.current = readSelection(view.state);
    updateSessionSnapshot(view.state);
    updateSessionMetrics(view.state);
    const initialThreadPresentation = buildThreadPresentation(threads, view.state);
    applyThreadPresentation(view, initialThreadPresentation, selectedThreadId);
    applyProposalReviewState(view, proposalReviewRef.current);
    if (document.fonts) {
      void document.fonts.ready.then(() => {
        if (viewRef.current === view) {
          view.requestMeasure();
        }
      });
    }

    return () => {
      cancelPendingSessionUpdates();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostElement]);

  // --- Re-resolve anchors when threads change ---
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const nextThreadPresentation = buildThreadPresentation(threads, view.state);
    applyThreadPresentation(view, nextThreadPresentation, selectedThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    view.dom.classList.toggle("cm-rendered-mode", editorMode === "rendered");
    view.dom.classList.toggle("cm-raw-mode", editorMode !== "rendered");
    view.dispatch({
      effects: [
        setEditorPresentationMode.of(editorMode),
        editorGutterCompartment.reconfigure(editorGutterExtensionsForMode(editorMode)),
      ],
    });
  }, [editorMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    view.dom.classList.toggle("cm-focus-mode", isFocusModeEnabled);
    view.dispatch({
      effects: [
        setEditorFocusMode.of(isFocusModeEnabled),
        ...(isFocusModeEnabled
          ? [
              EditorView.scrollIntoView(view.state.selection.main.head, {
                y: "center",
              }),
            ]
          : []),
      ],
    });
  }, [isFocusModeEnabled]);

  // --- Update decoration styling + scroll when selected thread changes ---
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const threadPresentation = getThreadPresentation(view.state);
    view.dispatch({
      effects: replaceThreadDecorations.of(
        buildThreadDecorationSet(threadPresentation, selectedThreadId),
      ),
    });

    if (selectedThreadId) {
      const activePlacement = threadPresentation.placements.find(
        (placement) => placement.threadIds.includes(selectedThreadId),
      );
      if (activePlacement) {
        const activeRange = threadPresentation.rangesByThreadId.get(selectedThreadId);
        view.dispatch({
          effects: EditorView.scrollIntoView(activeRange?.from ?? activePlacement.position, {
            y: "center",
            yMargin: 96,
          }),
        });
      }
    }
  }, [selectedThreadId]);

  return {
    session: sessionRef.current,
    sessionMetrics,
    sessionSnapshot,
    setHostElement,
  };
}

function applyThreadPresentation(
  view: EditorView,
  threadPresentation: ThreadPresentation,
  selectedThreadId: string | null,
) {
  view.dispatch({
    effects: [
      replaceThreadPresentation.of(threadPresentation),
      replaceThreadDecorations.of(buildThreadDecorationSet(threadPresentation, selectedThreadId)),
    ],
  });
}

function getThreadPresentation(state: EditorState) {
  return state.field(threadPresentationField);
}

function applyProposalReviewState(
  view: EditorView,
  proposalReview: ProposalReviewEditorState | null,
) {
  view.dispatch({
    effects: setProposalReviewEditorState.of(proposalReview),
  });
}

function restoreEditorScroll(view: EditorView, scrollTop: number, scrollLeft: number) {
  view.scrollDOM.scrollTop = scrollTop;
  view.scrollDOM.scrollLeft = scrollLeft;

  window.requestAnimationFrame(() => {
    if (!view.dom.isConnected) {
      return;
    }

    view.scrollDOM.scrollTop = scrollTop;
    view.scrollDOM.scrollLeft = scrollLeft;
  });
}

export function buildThreadDecorationSet(
  threadPresentation: ThreadPresentation,
  selectedThreadId: string | null,
): RangeSet<Decoration> {
  return measurePerf(
    "buildThreadDecorationSet",
    () => {
      const ranges: Range<Decoration>[] = [];

      threadPresentation.rangesByThreadId.forEach((range, threadId) => {
        ranges.push(
          Decoration.mark({
            class: [
              "cm-thread-anchor",
              selectedThreadId === threadId ? "is-active" : "",
              range.state === "fuzzy" ? "is-fuzzy" : "",
              range.state === "needs_review" ? "is-needs-review" : "",
            ]
              .filter(Boolean)
              .join(" "),
          }).range(range.from, range.to),
        );
      });

      return Decoration.set(ranges, true);
    },
    {
      placementCount: threadPresentation.placements.length,
      selectedThread: selectedThreadId ? 1 : 0,
    },
  );
}

export interface ThreadPlacement {
  anchorFrom: number;
  confidence: number;
  label: string;
  ordinals: number[];
  position: number;
  state: ThreadRecord["anchor"]["state"];
  threadIds: string[];
}

export interface ThreadRange {
  confidence: number;
  from: number;
  ordinal: number;
  state: ThreadRecord["anchor"]["state"];
  to: number;
}

export interface ThreadPresentation {
  placements: ThreadPlacement[];
  rangesByThreadId: Map<string, ThreadRange>;
}

export function buildThreadPresentation(
  threads: ThreadRecord[],
  state: EditorState,
): ThreadPresentation {
  return measurePerf(
    "buildThreadPresentation",
    () => {
      const content = state.doc.toString();
      const spatialThreads = threads.filter(
        (thread) => thread.status === "open" && !isDocumentLevelThread(thread),
      );
      const resolvedAnchors = resolveThreadAnchors(spatialThreads, content);
      const resolvedByThreadId = new Map(
        resolvedAnchors.map((anchor) => [anchor.threadId, anchor] as const),
      );
      const groupedPlacements = new Map<number, ThreadPlacement>();
      const rangesByThreadId = new Map<string, ThreadRange>();

      spatialThreads.forEach((thread, index) => {
        const resolvedAnchor = resolvedByThreadId.get(thread.id);
        const from = clampPosition(
          resolvedAnchor?.from ?? thread.anchor.startOffsetUtf16,
          state.doc.length,
        );
        const to = clampPosition(
          resolvedAnchor?.to ?? thread.anchor.endOffsetUtf16,
          state.doc.length,
        );
        const existingPlacement = groupedPlacements.get(from);

        if (from < to) {
          rangesByThreadId.set(thread.id, {
            confidence: thread.anchor.confidence,
            from,
            ordinal: index + 1,
            state: thread.anchor.state,
            to,
          });
        }

        if (existingPlacement) {
          existingPlacement.confidence = Math.max(
            existingPlacement.confidence,
            thread.anchor.confidence,
          );
          existingPlacement.ordinals.push(index + 1);
          existingPlacement.state = mergeThreadState(existingPlacement.state, thread.anchor.state);
          existingPlacement.threadIds.push(thread.id);
          return;
        }

        groupedPlacements.set(from, {
          anchorFrom: from,
          confidence: thread.anchor.confidence,
          label: "",
          ordinals: [index + 1],
          position: from,
          state: thread.anchor.state,
          threadIds: [thread.id],
        });
      });

      const placements = [...groupedPlacements.values()]
        .sort((left, right) => left.position - right.position)
        .map((placement) => ({
          ...placement,
          label:
            placement.threadIds.length === 1
              ? String(placement.ordinals[0])
              : String(placement.threadIds.length),
        }));

      return {
        placements,
        rangesByThreadId,
      };
    },
    {
      docLength: state.doc.length,
      threadCount: threads.length,
    },
  );
}

function isDocumentLevelThread(thread: ThreadRecord) {
  return thread.anchor.kind === "document" || thread.tags.includes("document");
}

function clampPosition(position: number, docLength: number) {
  return Math.max(0, Math.min(position, docLength));
}

const THREAD_MARKER_RIGHT_GAP_PX = 14;
const THREAD_MARKER_STACK_GAP_PX = 8;
const THREAD_MARKER_TOP_OFFSET_PX = 3;
const THREAD_MARKER_WIDTH_PX = 20;
const THREAD_MARKER_GROUP_WIDTH_PX = 24;
const THREAD_MARKER_HEIGHT_PX = 20;

interface ThreadMarkerRowEntry {
  placement: ThreadPlacement;
  top: number;
}

class ThreadLayerMarker {
  constructor(
    private readonly left: number,
    private readonly top: number,
    private readonly width: number,
    private readonly threadIds: string[],
    private readonly label: string,
    private readonly ordinals: number[],
    private readonly state: ThreadRecord["anchor"]["state"],
    private readonly confidence: number,
    private readonly isActive: boolean,
    private readonly onSelectThread?: (threadId: string | null) => void,
    private readonly selectedThreadId?: string | null,
  ) {}

  eq(other: ThreadLayerMarker) {
    return (
      this.left === other.left &&
      this.top === other.top &&
      this.width === other.width &&
      this.threadIds.join("|") === other.threadIds.join("|") &&
      this.label === other.label &&
      this.ordinals.join("|") === other.ordinals.join("|") &&
      this.state === other.state &&
      this.confidence === other.confidence &&
      this.isActive === other.isActive
    );
  }

  draw() {
    const button = document.createElement("button");
    button.type = "button";
    this.updateElement(button);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const threadIds =
        button.dataset.threadIds
          ?.split(" ")
          .map((threadId) => threadId.trim())
          .filter(Boolean) ?? [];
      const currentSelectedThreadId = button.dataset.selectedThreadId || null;
      this.onSelectThread?.(getNextSelectedThreadId(threadIds, currentSelectedThreadId));
    });
    return button;
  }

  update(dom: HTMLElement, other: ThreadLayerMarker) {
    if (other.threadIds.join("|") !== this.threadIds.join("|")) {
      return false;
    }

    this.updateElement(dom as HTMLButtonElement);
    return true;
  }

  private updateElement(button: HTMLButtonElement) {
    button.className = [
      "cm-thread-marker",
      this.threadIds.length > 1 ? "is-group" : "",
      this.isActive ? "is-active" : "",
      this.state === "fuzzy" ? "is-fuzzy" : "",
      this.state === "needs_review" ? "is-needs-review" : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.style.left = `${this.left}px`;
    button.style.top = `${this.top}px`;
    button.style.width = `${this.width}px`;
    button.style.height = `${THREAD_MARKER_HEIGHT_PX}px`;
    button.dataset.threadRole = "marker";
    button.dataset.threadIds = this.threadIds.join(" ");
    button.dataset.selectedThreadId = this.selectedThreadId ?? "";
    if (this.threadIds.length === 1) {
      button.dataset.threadId = this.threadIds[0];
    } else {
      delete button.dataset.threadId;
    }

    const threadLabel =
      this.ordinals.length === 1
        ? `Open thread ${this.ordinals[0]}`
        : `Open threads ${this.ordinals.join(", ")}`;
    button.setAttribute(
      "aria-label",
      `${threadLabel}, ${formatAnchorState(this.state)} ${Math.round(this.confidence * 100)} percent`,
    );
    button.title = `${threadLabel} · ${formatAnchorState(this.state)} (${Math.round(
      this.confidence * 100,
    )}%)`;
    button.textContent = this.label;
  }
}

function buildThreadLayerMarkers(
  view: EditorView,
  threadPresentation: ThreadPresentation,
  selectedThreadId: string | null,
  onSelectThread?: (threadId: string | null) => void,
) {
  const scrollRect = view.scrollDOM.getBoundingClientRect();
  const rowEntries = threadPresentation.placements
    .filter((placement) => isThreadPlacementVisible(placement, view.visibleRanges))
    .map((placement) => {
      const top = getThreadMarkerTop(view, placement.anchorFrom, scrollRect);
      if (top === null) {
        return null;
      }

      return {
        placement,
        top,
      } satisfies ThreadMarkerRowEntry;
    })
    .filter((entry): entry is ThreadMarkerRowEntry => entry !== null);

  const groupedRows = new Map<number, ThreadMarkerRowEntry[]>();

  rowEntries.forEach((entry) => {
    const rowKey = Math.round(entry.top);
    const group = groupedRows.get(rowKey) ?? [];
    group.push(entry);
    groupedRows.set(rowKey, group);
  });

  const railRight =
    view.scrollDOM.scrollLeft + view.scrollDOM.clientWidth - THREAD_MARKER_RIGHT_GAP_PX;

  return [...groupedRows.values()].flatMap((group) => {
    const sortedGroup = [...group].sort(
      (left, right) => left.placement.anchorFrom - right.placement.anchorFrom,
    );

    return sortedGroup.map((entry, index) => {
      const width =
        entry.placement.threadIds.length > 1 ? THREAD_MARKER_GROUP_WIDTH_PX : THREAD_MARKER_WIDTH_PX;
      const left = railRight - width - index * (width + THREAD_MARKER_STACK_GAP_PX);
      const isActive = selectedThreadId
        ? entry.placement.threadIds.includes(selectedThreadId)
        : false;

      return new ThreadLayerMarker(
        left,
        entry.top,
        width,
        entry.placement.threadIds,
        entry.placement.label,
        entry.placement.ordinals,
        entry.placement.state,
        entry.placement.confidence,
        isActive,
        onSelectThread,
        selectedThreadId,
      );
    });
  });
}

function isThreadPlacementVisible(
  placement: ThreadPlacement,
  visibleRanges: readonly VisibleRangeSpec[],
) {
  return visibleRanges.some(
    (visibleRange) =>
      placement.anchorFrom >= visibleRange.from && placement.anchorFrom <= visibleRange.to,
  );
}

function getThreadMarkerTop(view: EditorView, anchorFrom: number, scrollRect: DOMRect) {
  const position = clampPosition(anchorFrom, view.state.doc.length);
  const coords = view.coordsAtPos(position, 1) ?? view.coordsAtPos(position, -1);
  if (!coords) {
    return null;
  }

  return (
    view.scrollDOM.scrollTop +
    (coords.top - scrollRect.top) / view.scaleY +
    THREAD_MARKER_TOP_OFFSET_PX
  );
}

export function getNextSelectedThreadId(threadIds: string[], selectedThreadId: string | null) {
  const uniqueThreadIds = [...new Set(threadIds)];
  if (!uniqueThreadIds.length) {
    return null;
  }

  if (uniqueThreadIds.length === 1) {
    return selectedThreadId === uniqueThreadIds[0] ? null : uniqueThreadIds[0];
  }

  const currentIndex = selectedThreadId ? uniqueThreadIds.indexOf(selectedThreadId) : -1;
  return uniqueThreadIds[(currentIndex + 1 + uniqueThreadIds.length) % uniqueThreadIds.length];
}

export function mergeThreadState(
  currentState: ThreadRecord["anchor"]["state"],
  nextState: ThreadRecord["anchor"]["state"],
) {
  return threadStatePriority(nextState) > threadStatePriority(currentState) ? nextState : currentState;
}

export function threadStatePriority(state: ThreadRecord["anchor"]["state"]) {
  switch (state) {
    case "needs_review":
      return 4;
    case "detached":
      return 3;
    case "fuzzy":
      return 2;
    case "shifted":
      return 1;
    case "attached":
    default:
      return 0;
  }
}

export function formatAnchorState(state: ThreadRecord["anchor"]["state"]) {
  switch (state) {
    case "needs_review":
      return "Needs review";
    case "attached":
      return "Attached";
    case "shifted":
      return "Shifted";
    case "fuzzy":
      return "Fuzzy";
    case "detached":
      return "Detached";
    default:
      return state;
  }
}

export function readActiveMarkdownLink(state: EditorState) {
  return readActiveMarkdownLinkAtSelection(
    state,
    syntaxTree(state),
    state.selection.main.from,
    state.selection.main.to,
  );
}

function readActiveMarkdownLinkAtSelection(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree>,
  from: number,
  to: number,
) {
  const looseLocalLink = findLooseLocalMarkdownLinkAtRange(state, from, to);
  if (looseLocalLink) {
    return looseLocalLink;
  }

  const linkNodes = new Set<SyntaxNode>();
  const positions = new Set<number>([from]);

  if (to > from) {
    positions.add(Math.max(from, to - 1));
  }

  for (const position of positions) {
    const linkNode = findEnclosingSyntaxNodeNearPosition(tree, position, "Link", state.doc.length);
    if (!linkNode) {
      return null;
    }

    linkNodes.add(linkNode);
  }

  if (linkNodes.size !== 1) {
    return null;
  }

  const [linkNode] = [...linkNodes];
  if (from < linkNode.from || to > linkNode.to) {
    return null;
  }

  return parseMarkdownLinkNode(state, linkNode);
}

function readMarkdownLinkAtMouseEvent(view: EditorView, event: MouseEvent) {
  const position = safePosAtCoords(view, {
    x: event.clientX,
    y: event.clientY,
  });
  if (position === null) {
    return null;
  }

  const tree = syntaxTree(view.state);
  const linkNode = findEnclosingSyntaxNodeNearPosition(
    tree,
    position,
    "Link",
    view.state.doc.length,
  );
  return (
    (linkNode ? parseMarkdownLinkNode(view.state, linkNode) : null) ??
    findLooseLocalMarkdownLinkAtRange(view.state, position, position)
  );
}

function safePosAtCoords(view: EditorView, coords: { x: number; y: number }) {
  try {
    return view.posAtCoords(coords);
  } catch {
    return null;
  }
}

function findLooseLocalMarkdownLinkAtRange(state: EditorState, from: number, to: number) {
  for (const link of getLooseLocalMarkdownLinksForState(state)) {
    if (from >= link.from && to <= link.to) {
      return link;
    }
  }

  return null;
}

function findEnclosingSyntaxNodeNearPosition(
  tree: ReturnType<typeof syntaxTree>,
  position: number,
  nodeName: string,
  docLength: number,
) {
  const candidates = [
    position,
    Math.max(0, position - 1),
    Math.min(docLength, position + 1),
  ];

  for (const candidate of candidates) {
    const node = findEnclosingSyntaxNode(tree, candidate, nodeName);
    if (node) {
      return node;
    }
  }

  return null;
}

function findEnclosingSyntaxNode(
  tree: ReturnType<typeof syntaxTree>,
  position: number,
  nodeName: string,
) {
  let node: SyntaxNode | null = tree.resolveInner(position, 1);

  while (node) {
    if (node.name === nodeName) {
      return node;
    }

    node = node.parent;
  }

  return null;
}

function parseMarkdownLinkNode(state: EditorState, linkNode: SyntaxNode): ActiveMarkdownLink | null {
  const marks: SyntaxNode[] = [];
  let titleNode: SyntaxNode | null = null;
  let urlNode: SyntaxNode | null = null;

  for (let child = linkNode.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
      case "LinkMark":
        marks.push(child);
        break;
      case "URL":
        urlNode = child;
        break;
      case "LinkTitle":
        titleNode = child;
        break;
      default:
        break;
    }
  }

  if (marks.length < 4 || !urlNode) {
    return null;
  }

  const labelFrom = marks[0].to;
  const labelTo = marks[1].from;
  const titleText = titleNode ? state.doc.sliceString(titleNode.from, titleNode.to) : null;

  return {
    from: linkNode.from,
    label: state.doc.sliceString(labelFrom, labelTo),
    labelFrom,
    labelTo,
    title: titleText ? stripMarkdownLinkTitle(titleText) : null,
    titleFrom: titleNode?.from ?? null,
    titleTo: titleNode?.to ?? null,
    to: linkNode.to,
    url: state.doc.sliceString(urlNode.from, urlNode.to),
    urlFrom: urlNode.from,
    urlTo: urlNode.to,
  };
}

function stripMarkdownLinkTitle(value: string) {
  if (value.length >= 2) {
    const firstCharacter = value[0];
    const lastCharacter = value[value.length - 1];
    if (
      (firstCharacter === '"' && lastCharacter === '"') ||
      (firstCharacter === "'" && lastCharacter === "'") ||
      (firstCharacter === "(" && lastCharacter === ")")
    ) {
      return value.slice(1, -1);
    }
  }

  return value;
}

let clipboardTurndownService: TurndownService | null = null;

function getClipboardTurndownService() {
  if (clipboardTurndownService) {
    return clipboardTurndownService;
  }

  clipboardTurndownService = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    linkStyle: "inlined",
    strongDelimiter: "**",
  });
  return clipboardTurndownService;
}

export function convertClipboardHtmlToMarkdown(html: string, plainTextFallback = "") {
  const normalizedHtml = html.trim();
  if (!normalizedHtml) {
    return plainTextFallback;
  }

  const markdownText = getClipboardTurndownService()
    .turndown(normalizedHtml)
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (EMPTY_MARKDOWN_PASTE_PATTERN.test(markdownText)) {
    return plainTextFallback;
  }

  return markdownText;
}

export function toggleMarkdownInlineStyle(view: EditorView, marker: "*" | "**") {
  const selection = view.state.selection.main;
  const markerLength = marker.length;

  if (selection.empty) {
    view.dispatch({
      changes: {
        from: selection.from,
        insert: `${marker}${marker}`,
      },
      selection: {
        anchor: selection.from + markerLength,
      },
    });
    return true;
  }

  const selectedText = view.state.doc.sliceString(selection.from, selection.to);
  const selectedTextReplacement = toggleSelectedTextInlineStyle(selectedText, marker);
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

  const beforeRunLength = countRepeatedCharacterBefore(view.state.doc, selection.from, marker[0]);
  const afterRunLength = countRepeatedCharacterAfter(view.state.doc, selection.to, marker[0]);

  if (isInlineStyleActiveForMarker(marker, beforeRunLength, afterRunLength)) {
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
        insert: marker,
      },
      {
        from: selection.to,
        insert: marker,
      },
    ],
    selection: {
      anchor: selection.from + markerLength,
      head: selection.to + markerLength,
    },
  });
  return true;
}

function toggleSelectedTextInlineStyle(selectedText: string, marker: "*" | "**") {
  const markerLength = marker.length;
  const prefixRunLength = countRepeatedCharacterAtStart(selectedText, marker[0]);
  const suffixRunLength = countRepeatedCharacterAtEnd(selectedText, marker[0]);

  if (prefixRunLength === 0 || suffixRunLength === 0) {
    return null;
  }

  if (isInlineStyleActiveForMarker(marker, prefixRunLength, suffixRunLength)) {
    return selectedText.slice(markerLength, selectedText.length - markerLength);
  }

  return `${marker}${selectedText}${marker}`;
}

function isInlineStyleActiveForMarker(
  marker: "*" | "**",
  beforeRunLength: number,
  afterRunLength: number,
) {
  const balancedRunLength = Math.min(beforeRunLength, afterRunLength);
  if (marker === "*") {
    return balancedRunLength % 2 === 1;
  }

  return balancedRunLength >= marker.length;
}

function countRepeatedCharacterBefore(doc: Text, position: number, character: string) {
  let count = 0;
  let cursor = position - 1;
  while (cursor >= 0 && doc.sliceString(cursor, cursor + 1) === character) {
    count += 1;
    cursor -= 1;
  }
  return count;
}

function countRepeatedCharacterAfter(doc: Text, position: number, character: string) {
  let count = 0;
  let cursor = position;
  while (cursor < doc.length && doc.sliceString(cursor, cursor + 1) === character) {
    count += 1;
    cursor += 1;
  }
  return count;
}

function countRepeatedCharacterAtStart(text: string, character: string) {
  let count = 0;
  while (count < text.length && text[count] === character) {
    count += 1;
  }
  return count;
}

function countRepeatedCharacterAtEnd(text: string, character: string) {
  let count = 0;
  let cursor = text.length - 1;
  while (cursor >= 0 && text[cursor] === character) {
    count += 1;
    cursor -= 1;
  }
  return count;
}

export function buildMarkdownLinkReplacement({
  label,
  title,
  url,
}: {
  label: string;
  title: string | null;
  url: string;
}) {
  const normalizedTitle = title?.trim() ?? "";
  const titleSegment = normalizedTitle ? ` "${normalizedTitle}"` : "";
  return `[${label}](${formatMarkdownLinkUrl(url)}${titleSegment})`;
}

function formatMarkdownLinkUrl(url: string) {
  const trimmedUrl = url.trim();
  if (trimmedUrl.startsWith("<") && trimmedUrl.endsWith(">")) {
    return trimmedUrl;
  }

  if (/\s/.test(trimmedUrl)) {
    return `<${trimmedUrl}>`;
  }

  return trimmedUrl;
}

export function buildMarkdownFootnoteDefinitionReplacement({
  content,
  label,
}: {
  content: string;
  label: string;
}) {
  const normalizedLabel = label.trim();
  const contentLines = content.replace(/\r\n/g, "\n").split("\n");
  const firstLine = contentLines[0] ?? "";
  const continuationLines = contentLines.slice(1);
  let replacement = `[^${normalizedLabel}]:${firstLine ? ` ${firstLine}` : ""}`;

  for (const continuationLine of continuationLines) {
    replacement += continuationLine.length > 0 ? `\n    ${continuationLine}` : "\n    ";
  }

  return replacement;
}

function readActiveFootnoteReferenceAtSelection(
  state: EditorState,
  from: number,
  to: number,
): VisibleRangeSpec | null {
  const definedLabels = getFootnoteLabelsForState(state);
  const selection: EditorSelectionSnapshot = {
    endColumn: 0,
    endLine: 0,
    endOffsetUtf16: to,
    quote: state.doc.sliceString(from, to),
    startColumn: 0,
    startLine: 0,
    startOffsetUtf16: from,
  };
  const match = classifyFootnoteSelection(getDocumentTextForState(state), selection);

  if (!match || match.kind !== "footnote_reference") {
    return null;
  }

  if (
    !definedLabels.has(match.label) ||
    !isLikelyRenderableFootnoteReference(state, match.tokenStartOffsetUtf16)
  ) {
    return null;
  }

  const isWithinToken =
    from >= match.tokenStartOffsetUtf16 && to <= match.tokenEndOffsetUtf16;
  if (!isWithinToken) {
    return null;
  }

  return {
    from: match.tokenStartOffsetUtf16,
    to: match.tokenEndOffsetUtf16,
  };
}

export function readActiveFootnoteDefinition(state: EditorState) {
  return readActiveFootnoteDefinitionAtSelection(
    state,
    state.selection.main.from,
    state.selection.main.to,
  );
}

function readActiveFootnoteDefinitionAtSelection(
  state: EditorState,
  from: number,
  to: number,
): ActiveFootnoteDefinition | null {
  const selection: EditorSelectionSnapshot = {
    endColumn: 0,
    endLine: 0,
    endOffsetUtf16: to,
    quote: state.doc.sliceString(from, to),
    startColumn: 0,
    startLine: 0,
    startOffsetUtf16: from,
  };
  const match = classifyFootnoteSelection(getDocumentTextForState(state), selection);

  if (!match || match.kind !== "footnote_definition") {
    return null;
  }

  const isWithinBlock =
    from >= match.blockStartOffsetUtf16 && to <= match.blockEndOffsetUtf16 + 1;
  if (!isWithinBlock) {
    return null;
  }

  const blockContent = state.doc.sliceString(match.blockStartOffsetUtf16, match.blockEndOffsetUtf16);
  const parsedDefinition = parseMarkdownFootnoteDefinition(blockContent);
  if (!parsedDefinition) {
    return null;
  }

  return {
    blockContent,
    content: parsedDefinition.content,
    from: match.blockStartOffsetUtf16,
    label: parsedDefinition.label,
    to: match.blockEndOffsetUtf16,
    tokenFrom: match.tokenStartOffsetUtf16,
    tokenTo: match.tokenEndOffsetUtf16,
  };
}

function parseMarkdownFootnoteDefinition(blockContent: string) {
  const lines = blockContent.split("\n");
  const firstLine = lines[0] ?? "";
  const match = firstLine.match(/^(?: {0,3})\[\^([^\]\r\n]+)\]:(?:[ \t]?)(.*)$/);

  if (!match) {
    return null;
  }

  const contentLines = [match[2] ?? ""];
  for (const continuationLine of lines.slice(1)) {
    if (continuationLine === "") {
      contentLines.push("");
    } else if (continuationLine.startsWith("\t")) {
      contentLines.push(continuationLine.slice(1));
    } else if (continuationLine.startsWith("    ")) {
      contentLines.push(continuationLine.slice(4));
    } else {
      contentLines.push(continuationLine);
    }
  }

  return {
    content: contentLines.join("\n"),
    label: match[1] ?? "",
  };
}

function readSelection(state: EditorState): EditorSelectionSnapshot | null {
  const selection = state.selection.main;

  if (selection.empty) {
    return null;
  }

  const startLine = state.doc.lineAt(selection.from);
  const endLine = state.doc.lineAt(selection.to);

  return {
    startOffsetUtf16: selection.from,
    endOffsetUtf16: selection.to,
    startLine: startLine.number,
    startColumn: selection.from - startLine.from + 1,
    endLine: endLine.number,
    endColumn: selection.to - endLine.from + 1,
    quote: state.doc.sliceString(selection.from, selection.to),
  };
}

function createInitialSessionSnapshot(): CodeMirrorSessionSnapshot {
  return {
    isDirty: false,
    revision: 0,
  };
}

function createSessionSnapshot(
  _state: EditorState,
  revision: number,
  cleanRevision: number,
): CodeMirrorSessionSnapshot {
  return {
    isDirty: revision !== cleanRevision,
    revision,
  };
}

function createSessionMetricsFromContent(content: string): CodeMirrorSessionMetrics {
  return {
    characterCount: content.length,
    lineCount: content.length ? content.split(/\r?\n/).length : 1,
  };
}

function createSessionMetricsFromState(state: EditorState): CodeMirrorSessionMetrics {
  return {
    characterCount: state.doc.length,
    lineCount: state.doc.lines,
  };
}

export function mapThreadPresentation(
  threadPresentation: ThreadPresentation,
  changes: ChangeDesc,
): ThreadPresentation {
  if (threadPresentation.placements.length === 0 && threadPresentation.rangesByThreadId.size === 0) {
    return threadPresentation;
  }

  return {
    placements: threadPresentation.placements.map((placement) => ({
      ...placement,
      anchorFrom: changes.mapPos(placement.anchorFrom, 1),
      position: changes.mapPos(placement.position, 1),
    })),
    rangesByThreadId: new Map(
      [...threadPresentation.rangesByThreadId.entries()].flatMap(([threadId, range]) => {
        const from = changes.mapPos(range.from, 1);
        const to = changes.mapPos(range.to, -1);

        if (from >= to) {
          return [];
        }

        return [
          [
            threadId,
            {
              ...range,
              from,
              to,
            },
          ] as const,
        ];
      }),
    ),
  };
}

function areSelectionsEqual(
  current: EditorSelectionSnapshot | null,
  next: EditorSelectionSnapshot | null,
) {
  if (current === next) {
    return true;
  }

  if (!current || !next) {
    return false;
  }

  return (
    current.startOffsetUtf16 === next.startOffsetUtf16 &&
    current.endOffsetUtf16 === next.endOffsetUtf16 &&
    current.startLine === next.startLine &&
    current.startColumn === next.startColumn &&
    current.endLine === next.endLine &&
    current.endColumn === next.endColumn &&
    current.quote === next.quote
  );
}

function areActiveFootnoteDefinitionsEqual(
  current: ActiveFootnoteDefinition | null,
  next: ActiveFootnoteDefinition | null,
) {
  if (current === next) {
    return true;
  }

  if (!current || !next) {
    return false;
  }

  return (
    current.from === next.from &&
    current.to === next.to &&
    current.tokenFrom === next.tokenFrom &&
    current.tokenTo === next.tokenTo &&
    current.label === next.label &&
    current.content === next.content &&
    current.blockContent === next.blockContent
  );
}

function areActiveMarkdownLinksEqual(
  current: ActiveMarkdownLink | null,
  next: ActiveMarkdownLink | null,
) {
  if (current === next) {
    return true;
  }

  if (!current || !next) {
    return false;
  }

  return (
    current.from === next.from &&
    current.to === next.to &&
    current.label === next.label &&
    current.url === next.url &&
    current.title === next.title &&
    current.labelFrom === next.labelFrom &&
    current.labelTo === next.labelTo &&
    current.urlFrom === next.urlFrom &&
    current.urlTo === next.urlTo &&
    current.titleFrom === next.titleFrom &&
    current.titleTo === next.titleTo
  );
}
