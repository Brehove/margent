import { create } from "zustand";
import type { ProposalRecord } from "../types/proposal";
import type { ThreadRecord } from "../types/thread";

interface ReviewDataStore {
  errorMessage: string | null;
  isLoading: boolean;
  proposals: ProposalRecord[];
  revision: number;
  threads: ThreadRecord[];
  removeThread: (threadId: string) => void;
  reset: () => void;
  setErrorMessage: (message: string | null) => void;
  setIsLoading: (value: boolean) => void;
  setReviewData: (data: { proposals: ProposalRecord[]; threads: ThreadRecord[] }) => void;
  upsertProposal: (proposal: ProposalRecord) => void;
  upsertThread: (thread: ThreadRecord) => void;
}

const initialState = {
  errorMessage: null,
  isLoading: false,
  proposals: [] as ProposalRecord[],
  revision: 0,
  threads: [] as ThreadRecord[],
};

export const useReviewDataStore = create<ReviewDataStore>((set) => ({
  ...initialState,
  removeThread: (threadId) =>
    set((state) => ({
      revision: state.revision + 1,
      threads: state.threads.filter((thread) => thread.id !== threadId),
    })),
  reset: () => set(initialState),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setReviewData: ({ proposals, threads }) =>
    set((state) => ({
      proposals: sortProposals(proposals),
      revision: state.revision + 1,
      threads: sortThreads(threads),
    })),
  upsertProposal: (proposal) =>
    set((state) => ({
      proposals: sortProposals([
        proposal,
        ...state.proposals.filter((entry) => entry.id !== proposal.id),
      ]),
      revision: state.revision + 1,
    })),
  upsertThread: (thread) =>
    set((state) => ({
      revision: state.revision + 1,
      threads: sortThreads([thread, ...state.threads.filter((entry) => entry.id !== thread.id)]),
    })),
}));

export function threadsForDocument(threads: ThreadRecord[], documentId: string | null | undefined) {
  if (!documentId) {
    return [];
  }

  return threads.filter((thread) => thread.documentId === documentId);
}

export function proposalsForDocument(
  proposals: ProposalRecord[],
  documentId: string | null | undefined,
) {
  if (!documentId) {
    return [];
  }

  return proposals.filter((proposal) => proposal.documentId === documentId);
}

function sortThreads(threads: ThreadRecord[]) {
  return [...threads].sort((left, right) => {
    const statusRank = threadStatusRank(left.status) - threadStatusRank(right.status);
    return statusRank || right.updatedAt.localeCompare(left.updatedAt);
  });
}

function threadStatusRank(status: ThreadRecord["status"]) {
  switch (status) {
    case "open":
      return 0;
    case "resolved":
      return 1;
    case "archived":
    default:
      return 2;
  }
}

function sortProposals(proposals: ProposalRecord[]) {
  return [...proposals].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
