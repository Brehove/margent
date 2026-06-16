export interface HeadingIndexEntry {
  depth: number;
  text: string;
  line: number;
}

export interface DocumentSummary {
  id: string;
  relativePath: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  currentContentHash: string;
  lastKnownLineEnding: string;
  frontmatterMode: string;
  wordCount: number;
  headingIndex: HeadingIndexEntry[];
}

export interface DocumentPayload extends DocumentSummary {
  absolutePath: string;
  content: string;
}

export interface WorkspaceSnapshot {
  rootPath: string;
  openedPath: string | null;
  mdreviewPath: string;
  selectedRelativePath: string | null;
  documents: DocumentSummary[];
}

export interface AssetImportResult {
  absolutePath: string;
  relativePath: string;
}

export interface WorkspaceOpenRequest {
  documentRelativePath?: string | null;
  id: number;
  path: string;
  threadId?: string | null;
  workspaceRoot?: string | null;
}
