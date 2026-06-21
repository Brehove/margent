import type { DocumentSnapshotRecord } from "./snapshot";

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

export interface DocumentVersion {
  contentHash: string;
  modifiedNs?: string | null;
  size: number;
}

export interface DocumentPayload extends DocumentSummary {
  absolutePath: string;
  content: string;
  version: DocumentVersion;
}

export type SaveDocumentIfCurrentResult =
  | {
      status: "saved";
      document: DocumentPayload;
      operationId: string;
    }
  | {
      status: "conflict";
      expectedVersion: DocumentVersion;
      actualVersion: DocumentVersion;
      operationId: string;
    };

export interface SaveConflict {
  actualVersion: DocumentVersion;
  diskDocument: DocumentPayload;
  expectedVersion: DocumentVersion;
  localContent: string;
  operationId: string;
  relativePath: string;
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

export interface DocumentSnapshotRevertResult {
  snapshot: DocumentSnapshotRecord;
  document: DocumentPayload;
}

export interface WorkspaceOpenRequest {
  documentRelativePath?: string | null;
  id: number;
  path: string;
  threadId?: string | null;
  workspaceRoot?: string | null;
}
