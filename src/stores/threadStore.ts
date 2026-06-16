import { create } from "zustand";
import type { ThreadRecord } from "../types/thread";

interface ThreadStore {
  errorMessage: string | null;
  isLoading: boolean;
  isSaving: boolean;
  selectedThreadId: string | null;
  selectionRevision: number;
  threads: ThreadRecord[];
  removeThread: (threadId: string) => void;
  reset: () => void;
  selectThread: (threadId: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  setIsLoading: (value: boolean) => void;
  setIsSaving: (value: boolean) => void;
  setThreads: (threads: ThreadRecord[]) => void;
  upsertThread: (thread: ThreadRecord) => void;
}

const initialState = {
  errorMessage: null,
  isLoading: false,
  isSaving: false,
  selectedThreadId: null,
  selectionRevision: 0,
  threads: [] as ThreadRecord[],
};

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

export const useThreadStore = create<ThreadStore>((set) => ({
  ...initialState,
  removeThread: (threadId) =>
    set((state) => {
      const remaining = state.threads.filter((t) => t.id !== threadId);
      return {
        selectedThreadId:
          state.selectedThreadId === threadId ? (remaining[0]?.id ?? null) : state.selectedThreadId,
        threads: remaining,
      };
    }),
  reset: () => set(initialState),
  selectThread: (selectedThreadId) =>
    set((state) => ({ selectedThreadId, selectionRevision: state.selectionRevision + 1 })),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setIsSaving: (isSaving) => set({ isSaving }),
  setThreads: (threads) =>
    set((state) => {
      const merged = threads.map((thread) => {
        const existing = state.threads.find((entry) => entry.id === thread.id);
        if (!existing || thread.messages.length > 0 || existing.messages.length === 0) {
          return thread;
        }

        return {
          ...thread,
          messages: existing.messages,
        };
      });
      const sorted = sortThreads(merged);
      const stillSelected = sorted.some((thread) => thread.id === state.selectedThreadId);

      return {
        selectedThreadId: stillSelected ? state.selectedThreadId : null,
        threads: sorted,
      };
    }),
  upsertThread: (thread) =>
    set((state) => {
      const withoutCurrent = state.threads.filter((entry) => entry.id !== thread.id);

      return {
        selectedThreadId: thread.id,
        threads: sortThreads([...withoutCurrent, thread]),
      };
    }),
}));
