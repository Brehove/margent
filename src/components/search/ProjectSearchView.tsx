import { memo, type FormEvent, useEffect, useRef, useState } from "react";
import { invokeBackend } from "../../lib/backend";
import { getErrorMessage } from "../../lib/errorMessage";
import type {
  ProjectSearchMode,
  ProjectSearchResponse,
  ProjectSearchResult,
} from "../../types/search";

interface ProjectSearchViewProps {
  onOpenResult: (result: ProjectSearchResult) => void;
  workspaceRoot: string;
}

export const ProjectSearchView = memo(function ProjectSearchView({
  onOpenResult,
  workspaceRoot,
}: ProjectSearchViewProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<ProjectSearchMode>("literal");
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<ProjectSearchResponse | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery || isLoading) {
      return;
    }

    setErrorMessage(null);
    setIsLoading(true);
    try {
      const nextResponse = await invokeBackend<ProjectSearchResponse>("search_workspace", {
        caseSensitive,
        mode,
        query: trimmedQuery,
        workspaceRoot,
      });
      setResponse(nextResponse);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to search this workspace."));
    } finally {
      setIsLoading(false);
    }
  };

  const resultCount = response?.results.length ?? 0;

  return (
    <section aria-label="Project Search" className="project-search-view">
      <header className="project-search-header">
        <div>
          <p className="eyebrow-lbl">Workspace</p>
          <h1>Project Search</h1>
        </div>
        <span className="project-search-root" title={workspaceRoot}>
          {workspaceRoot}
        </span>
      </header>

      <form className="project-search-form" onSubmit={runSearch}>
        <label className="project-search-input-label">
          <span>Search</span>
          <input
            ref={inputRef}
            aria-label="Search workspace"
            className="project-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search all markdown files"
            type="search"
            value={query}
          />
        </label>

        <div aria-label="Search mode" className="seg project-search-mode" role="tablist">
          <button
            aria-selected={mode === "literal"}
            className={mode === "literal" ? "on" : undefined}
            onClick={() => setMode("literal")}
            role="tab"
            type="button"
          >
            Literal
          </button>
          <button
            aria-selected={mode === "regex"}
            className={mode === "regex" ? "on" : undefined}
            onClick={() => setMode("regex")}
            role="tab"
            type="button"
          >
            Regex
          </button>
        </div>

        <label className="project-search-checkbox">
          <input
            checked={caseSensitive}
            onChange={(event) => setCaseSensitive(event.target.checked)}
            type="checkbox"
          />
          <span>Match case</span>
        </label>

        <button className="primary-button" disabled={!query.trim() || isLoading} type="submit">
          {isLoading ? "Searching..." : "Search"}
        </button>
      </form>

      {errorMessage ? <div className="banner error-banner">{errorMessage}</div> : null}

      <div className="project-search-summary" aria-live="polite">
        {response ? (
          <span>
            {resultCount} {resultCount === 1 ? "match" : "matches"} in {response.searchedFiles}{" "}
            {response.searchedFiles === 1 ? "file" : "files"}
            {response.truncated ? " (showing first 500)" : ""}
          </span>
        ) : (
          <span>Search workspace markdown files by literal text or regular expression.</span>
        )}
      </div>

      <div className="project-search-results">
        {response && response.results.length === 0 ? (
          <div className="project-search-empty">No matches</div>
        ) : null}
        {response?.results.map((result, index) => (
          <button
            className="project-search-result"
            key={`${result.relativePath}:${result.line}:${result.column}:${index}`}
            onClick={() => onOpenResult(result)}
            type="button"
          >
            <span className="project-search-result-head">
              <strong>{result.relativePath}</strong>
              <span>
                Line {result.line}, Col {result.column}
              </span>
            </span>
            {result.beforeContext ? (
              <span className="project-search-context">{result.beforeContext}</span>
            ) : null}
            <span className="project-search-line">
              {renderHighlightedLine(result)}
            </span>
            {result.afterContext ? (
              <span className="project-search-context">{result.afterContext}</span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
});

function renderHighlightedLine(result: ProjectSearchResult) {
  const characters = Array.from(result.lineText);
  const startIndex = Math.max(0, result.matchStartColumn - 1);
  const endIndex = Math.max(startIndex, result.matchEndColumn - 1);
  return (
    <>
      {characters.slice(0, startIndex).join("")}
      <mark>{characters.slice(startIndex, endIndex).join("")}</mark>
      {characters.slice(endIndex).join("")}
    </>
  );
}
