export type ProjectSearchMode = "literal" | "regex";

export interface ProjectSearchResponse {
  caseSensitive: boolean;
  mode: ProjectSearchMode;
  query: string;
  results: ProjectSearchResult[];
  searchedFiles: number;
  truncated: boolean;
}

export interface ProjectSearchResult {
  afterContext: string | null;
  beforeContext: string | null;
  column: number;
  displayName: string;
  documentId: string;
  line: number;
  lineText: string;
  matchEndColumn: number;
  matchStartColumn: number;
  matchText: string;
  relativePath: string;
}
