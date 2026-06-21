export interface DocumentSnapshotRecord {
  id: string;
  documentId: string;
  relativePath: string;
  contentHash: string;
  content: string;
  createdAt: string;
  reason: string;
  proposalId: string | null;
}
