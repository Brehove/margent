import { describe, expect, it } from "vitest";
import { parseThreadMessageBodyLinks } from "../src/components/editor/DocumentEditor";

describe("parseThreadMessageBodyLinks", () => {
  it("turns bare HTTP URLs into link segments", () => {
    expect(parseThreadMessageBodyLinks("Read https://example.com/path now.")).toEqual([
      {
        kind: "text",
        text: "Read ",
      },
      {
        href: "https://example.com/path",
        kind: "link",
        text: "https://example.com/path",
      },
      {
        kind: "text",
        text: " now.",
      },
    ]);
  });

  it("turns markdown links into link segments", () => {
    expect(parseThreadMessageBodyLinks("Use [the source](https://example.com/a).")).toEqual([
      {
        kind: "text",
        text: "Use ",
      },
      {
        href: "https://example.com/a",
        kind: "link",
        text: "the source",
      },
      {
        kind: "text",
        text: ".",
      },
    ]);
  });

  it("keeps trailing punctuation out of bare links", () => {
    expect(parseThreadMessageBodyLinks("See https://example.com/test).")).toEqual([
      {
        kind: "text",
        text: "See ",
      },
      {
        href: "https://example.com/test",
        kind: "link",
        text: "https://example.com/test",
      },
      {
        kind: "text",
        text: ").",
      },
    ]);
  });

  it("leaves non-http markdown targets as plain text", () => {
    expect(parseThreadMessageBodyLinks("Unsafe [link](javascript:alert(1)) stays text.")).toEqual([
      {
        kind: "text",
        text: "Unsafe [link](javascript:alert(1)) stays text.",
      },
    ]);
  });
});
