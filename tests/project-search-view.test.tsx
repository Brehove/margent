import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSearchView } from "../src/components/search/ProjectSearchView";
import { invokeBackend } from "../src/lib/backend";
import type { ProjectSearchResponse, ProjectSearchResult } from "../src/types/search";

vi.mock("../src/lib/backend", () => ({
  invokeBackend: vi.fn(),
}));

const invokeBackendMock = vi.mocked(invokeBackend);

function makeResult(overrides: Partial<ProjectSearchResult> = {}): ProjectSearchResult {
  return {
    afterContext: "Final line.",
    beforeContext: "# Draft",
    column: 5,
    displayName: "chapter.md",
    documentId: "doc-1",
    line: 2,
    lineText: "The AI era needs judgment.",
    matchEndColumn: 11,
    matchStartColumn: 5,
    matchText: "AI era",
    relativePath: "docs/chapter.md",
    ...overrides,
  };
}

function makeResponse(overrides: Partial<ProjectSearchResponse> = {}): ProjectSearchResponse {
  return {
    caseSensitive: false,
    mode: "literal",
    query: "AI era",
    results: [makeResult()],
    searchedFiles: 3,
    truncated: false,
    ...overrides,
  };
}

describe("ProjectSearchView", () => {
  beforeEach(() => {
    invokeBackendMock.mockReset();
  });

  it("runs a literal workspace search and renders line context", async () => {
    invokeBackendMock.mockResolvedValue(makeResponse());

    render(<ProjectSearchView onOpenResult={vi.fn()} workspaceRoot="/workspace" />);

    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: "AI era" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(invokeBackendMock).toHaveBeenCalledWith("search_workspace", {
        caseSensitive: false,
        mode: "literal",
        query: "AI era",
        workspaceRoot: "/workspace",
      });
    });

    expect(await screen.findByText("docs/chapter.md")).toBeInTheDocument();
    expect(screen.getByText("Line 2, Col 5")).toBeInTheDocument();
    expect(screen.getByText("# Draft")).toBeInTheDocument();
    expect(screen.getByText("Final line.")).toBeInTheDocument();
    expect(screen.getByText("AI era").tagName).toBe("MARK");
    expect(screen.getByText("1 match in 3 files")).toBeInTheDocument();
  });

  it("supports regex and match-case controls", async () => {
    invokeBackendMock.mockResolvedValue(makeResponse({ caseSensitive: true, mode: "regex" }));

    render(<ProjectSearchView onOpenResult={vi.fn()} workspaceRoot="/workspace" />);

    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: String.raw`AI\s+era` },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Regex" }));
    fireEvent.click(screen.getByLabelText("Match case"));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(invokeBackendMock).toHaveBeenCalledWith("search_workspace", {
        caseSensitive: true,
        mode: "regex",
        query: String.raw`AI\s+era`,
        workspaceRoot: "/workspace",
      });
    });
  });

  it("opens the selected result", async () => {
    const onOpenResult = vi.fn();
    const result = makeResult();
    invokeBackendMock.mockResolvedValue(makeResponse({ results: [result] }));

    render(<ProjectSearchView onOpenResult={onOpenResult} workspaceRoot="/workspace" />);

    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: "AI era" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const resultButton = (await screen.findByText("docs/chapter.md")).closest("button");
    expect(resultButton).not.toBeNull();
    fireEvent.click(resultButton!);

    expect(onOpenResult).toHaveBeenCalledWith(result);
  });

  it("surfaces backend search errors", async () => {
    invokeBackendMock.mockRejectedValue(new Error("Invalid regular expression: unclosed group"));

    render(<ProjectSearchView onOpenResult={vi.fn()} workspaceRoot="/workspace" />);

    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: "(" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Regex" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Invalid regular expression: unclosed group")).toBeInTheDocument();
  });
});
