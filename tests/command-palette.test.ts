import { describe, expect, it } from "vitest";
import { filterCommandPaletteEntries } from "../src/components/command/CommandPalette";

describe("command palette filtering", () => {
  const entries = [
    {
      detail: "drafts/oer-chapter.md",
      keywords: ["chapter", "pressbooks"],
      label: "OER Chapter",
    },
    {
      detail: "notes/meeting.md",
      keywords: ["agenda"],
      label: "Meeting Notes",
    },
    {
      detail: "drafts/opening.md",
      keywords: ["essay"],
      label: "Opening Draft",
    },
  ];

  it("preserves entry order for an empty query", () => {
    expect(filterCommandPaletteEntries(entries, "").map((entry) => entry.label)).toEqual([
      "OER Chapter",
      "Meeting Notes",
      "Opening Draft",
    ]);
  });

  it("matches across labels, details, and keywords", () => {
    expect(filterCommandPaletteEntries(entries, "draft").map((entry) => entry.label)).toEqual([
      "Opening Draft",
      "OER Chapter",
    ]);
    expect(filterCommandPaletteEntries(entries, "pressbooks").map((entry) => entry.label)).toEqual([
      "OER Chapter",
    ]);
    expect(filterCommandPaletteEntries(entries, "notes agenda").map((entry) => entry.label)).toEqual([
      "Meeting Notes",
    ]);
  });
});
