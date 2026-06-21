import type { DocumentPayload, DocumentVersion } from "./workspace";
import type { DocumentSnapshotRecord } from "./snapshot";

export type { DocumentSnapshotRecord } from "./snapshot";

export interface AdapterDefinition {
  id: string;
  name: string;
  command: string;
  args: string[];
  workingDirectoryMode: string;
  environmentAllowlist: string[];
  inputMode: string;
  outputMode: string;
  capabilities: string[];
  timeoutSeconds: number;
}

export interface ProposalRecord {
  schemaVersion: number;
  id: string;
  documentId: string;
  threadIds: string[];
  adapterId: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "accepted" | "rejected" | "stale" | "failed";
  baseContentHash: string;
  responseMode: string;
  summary: string;
  assistantMessage: string;
  updatedDocumentText: string | null;
  unifiedDiff: string | null;
  computedDiff: string;
  warnings: string[];
  resolveThreadIds: string[];
  stderr: string | null;
  errorMessage: string | null;
}

export interface TextRange {
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

export type HunkKind = "insert" | "delete" | "replace";

export interface ChangeSource {
  kind: string;
  id?: string | null;
}

export interface ReviewHunk {
  id: string;
  index: number;
  kind: HunkKind;
  oldRange: TextRange;
  newRange: TextRange;
  beforeText: string;
  afterText: string;
  headingPath: string[];
  summary?: string | null;
}

export interface ReviewChangeSet {
  id: string;
  documentId: string;
  source: ChangeSource;
  beforeHash: string;
  afterHash: string;
  baseHash?: string | null;
  hunks: ReviewHunk[];
  warnings: string[];
}

export type ProposalChangeSetResult =
  | {
      status: "ready";
      proposal: ProposalRecord;
      changeSet: ReviewChangeSet;
      documentVersion: DocumentVersion;
    }
  | {
      status: "stale";
      proposal: ProposalRecord;
      message: string;
    }
  | {
      status: "unsupported";
      proposal: ProposalRecord;
      message: string;
    };

export interface ProposalMutationResult {
  proposal: ProposalRecord;
  document: DocumentPayload | null;
  snapshot: DocumentSnapshotRecord | null;
  message: string | null;
}

export type ProposalHunkAcceptResult =
  | {
      status: "applied";
      result: ProposalMutationResult;
      appliedHunkIds: string[];
    }
  | {
      status: "conflict";
      expectedVersion: DocumentVersion;
      actualVersion: DocumentVersion;
      message: string;
    }
  | {
      status: "stale";
      proposal: ProposalRecord;
      message: string;
    };
