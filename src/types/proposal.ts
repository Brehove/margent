import type { DocumentPayload } from "./workspace";

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

export interface ProposalMutationResult {
  proposal: ProposalRecord;
  document: DocumentPayload | null;
  message: string | null;
}
