export interface EditorSelectionSnapshot {
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  quote: string;
}

export type AnchorState = "attached" | "shifted" | "fuzzy" | "detached" | "needs_review";
export type AnchorKind =
  | "text_span"
  | "footnote_reference"
  | "footnote_definition"
  | "document";

export interface FootnoteAnchorMetadata {
  label: string;
  occurrence: number;
}

export interface AnchorRecord {
  quote: string;
  prefixContext: string;
  suffixContext: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  headingPath: string[];
  blockFingerprint: string;
  baseContentHash: string;
  kind?: AnchorKind;
  footnote?: FootnoteAnchorMetadata | null;
  state: AnchorState;
  confidence: number;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  authorType: "user" | "agent" | "assistant" | "system";
  authorName: string;
  agentId: string | null;
  adapterId: string | null;
  replyToMessageId: string | null;
  createdAt: string;
  body: string;
  kind: "comment" | "reply" | "instruction" | "summary" | "system";
}

export interface ThreadRecord {
  schemaVersion: number;
  id: string;
  documentId: string;
  status: "open" | "resolved" | "archived";
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  title: string;
  tags: string[];
  anchor: AnchorRecord;
  createdContentHash?: string | null;
  lastReanchorContentHash?: string | null;
  reviewRound?: string | null;
  reviewDone?: boolean;
  messages: MessageRecord[];
  linkedProposalIds: string[];
  providerSessions: Record<string, string>;
}

export interface AgentCursorRecord {
  agentId: string;
  providerId: string | null;
  adapterId: string | null;
  lastSeenEventId: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  notes: string | null;
}
