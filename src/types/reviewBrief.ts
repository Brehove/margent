import type { ProposalRecord } from "./proposal";
import type { MessageRecord, ThreadRecord } from "./thread";
import type { DocumentSummary } from "./workspace";

export type ReviewBriefEntryKind = "proposal" | "agent-thread";

export interface ReviewBriefEntry {
  agentSummary: string;
  anchorExcerpt: string;
  document: DocumentSummary;
  id: string;
  isOlderVersion: boolean;
  kind: ReviewBriefEntryKind;
  latestAgentMessage?: MessageRecord;
  proposal?: ProposalRecord;
  thread?: ThreadRecord;
  updatedAt: string;
}
