import { describe, expect, it } from "vitest";
import {
  classifyFootnoteSelection,
  resolveFootnoteAnchorSemantic,
} from "../src/lib/footnote";
import type { EditorSelectionSnapshot } from "../src/types/thread";

function makeSelection(
  content: string,
  target: string,
  occurrence = 1,
  length = target.length,
): EditorSelectionSnapshot {
  let from = -1;
  let searchFrom = 0;

  for (let index = 0; index < occurrence; index += 1) {
    from = content.indexOf(target, searchFrom);
    if (from === -1) {
      throw new Error(`Could not find occurrence ${occurrence} of "${target}"`);
    }

    searchFrom = from + target.length;
  }

  const to = from + length;
  const beforeStart = content.slice(0, from);
  const beforeEnd = content.slice(0, to);

  return {
    startOffsetUtf16: from,
    endOffsetUtf16: to,
    startLine: beforeStart.split("\n").length,
    startColumn: from - beforeStart.lastIndexOf("\n"),
    endLine: beforeEnd.split("\n").length,
    endColumn: to - beforeEnd.lastIndexOf("\n"),
    quote: content.slice(from, to),
  };
}

describe("classifyFootnoteSelection", () => {
  const content = [
    "Paragraph with a footnote ref [^alpha] and another [^alpha].",
    "",
    "[^alpha]: First definition line",
    "    continuation line",
    "",
    "Trailing paragraph.",
  ].join("\n");

  it("identifies a footnote reference selection", () => {
    const selection = makeSelection(content, "[^alpha]");
    const match = classifyFootnoteSelection(content, selection);

    expect(match).toMatchObject({
      kind: "footnote_reference",
      label: "alpha",
      occurrence: 1,
      tokenStartOffsetUtf16: selection.startOffsetUtf16,
      tokenEndOffsetUtf16: selection.endOffsetUtf16,
    });
  });

  it("counts repeated reference occurrences independently", () => {
    const selection = makeSelection(content, "[^alpha]", 2);
    const match = classifyFootnoteSelection(content, selection);

    expect(match).toMatchObject({
      kind: "footnote_reference",
      label: "alpha",
      occurrence: 2,
    });
  });

  it("does not misclassify a definition token as a reference", () => {
    const selection = makeSelection(content, "[^alpha]:", 1, "[^alpha]:".length);
    const match = classifyFootnoteSelection(content, selection);

    expect(match).toMatchObject({
      kind: "footnote_definition",
      label: "alpha",
      occurrence: 1,
    });
  });

  it("classifies selections inside a definition continuation block", () => {
    const selection = makeSelection(content, "continuation");
    const match = classifyFootnoteSelection(content, selection);

    expect(match).toMatchObject({
      kind: "footnote_definition",
      label: "alpha",
      occurrence: 1,
      startLine: 3,
      endLine: 4,
    });
    expect(match?.blockEndOffsetUtf16).toBeGreaterThan(selection.endOffsetUtf16);
  });

  it("returns null when the selection does not overlap a footnote", () => {
    const selection = makeSelection(content, "Trailing");

    expect(classifyFootnoteSelection(content, selection)).toBeNull();
  });

  it("does not classify footnote-like text inside inline code", () => {
    const codeContent = "Example `[^alpha]` inline.\n\n[^alpha]: Definition\n";
    const selection = makeSelection(codeContent, "[^alpha]");

    expect(classifyFootnoteSelection(codeContent, selection)).toBeNull();
  });

});

describe("resolveFootnoteAnchorSemantic", () => {
  const content = "Sentence with footnote [^alpha] inline.\n\n[^alpha]: Definition text\n";

  it("returns semantic metadata for a selection contained within a footnote reference token", () => {
    const selection = makeSelection(content, "[^alpha]");

    expect(resolveFootnoteAnchorSemantic(content, selection)).toEqual({
      kind: "footnote_reference",
      footnote: {
        label: "alpha",
        occurrence: 1,
      },
    });
  });

  it("rejects broad sentence selections that merely include a footnote reference", () => {
    const selection = makeSelection(content, "Sentence with footnote [^alpha] inline.");

    expect(resolveFootnoteAnchorSemantic(content, selection)).toBeNull();
  });

  it("returns semantic metadata for selections contained within a definition block", () => {
    const selection = makeSelection(content, "Definition");

    expect(resolveFootnoteAnchorSemantic(content, selection)).toEqual({
      kind: "footnote_definition",
      footnote: {
        label: "alpha",
        occurrence: 1,
      },
    });
  });
});
