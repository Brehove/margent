import { useCallback, useMemo, useState } from "react";
import { invokeBackend } from "../lib/backend";
import { getErrorMessage } from "../lib/errorMessage";
import { useReviewDataStore } from "../stores/reviewDataStore";
import type { ProposalMutationResult, ProposalRecord } from "../types/proposal";
import type { ReviewBriefEntry } from "../types/reviewBrief";
import type { MessageRecord, ThreadRecord } from "../types/thread";
import type { DocumentPayload, DocumentSummary, WorkspaceSnapshot } from "../types/workspace";

interface UseReviewBriefOptions {
  activeDocument: DocumentPayload | null;
  onActiveDocumentApplied?: (document: DocumentPayload) => void;
  onActiveThreadUpdated?: (thread: ThreadRecord) => void;
  onRefreshReviewData?: () => Promise<void>;
  workspace: WorkspaceSnapshot | null;
}

type BriefActionKind = "accept" | "reject" | "reply" | null;

export function useReviewBrief({
  activeDocument,
  onActiveDocumentApplied,
  onActiveThreadUpdated,
  onRefreshReviewData,
  workspace,
}: UseReviewBriefOptions) {
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [activeActionKind, setActiveActionKind] = useState<BriefActionKind>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const reviewDataErrorMessage = useReviewDataStore((state) => state.errorMessage);
  const isLoading = useReviewDataStore((state) => state.isLoading);
  const proposals = useReviewDataStore((state) => state.proposals);
  const threads = useReviewDataStore((state) => state.threads);
  const upsertReviewProposal = useReviewDataStore((state) => state.upsertProposal);
  const upsertReviewThread = useReviewDataStore((state) => state.upsertThread);
  const workspaceRoot = workspace?.rootPath ?? null;

  const entries = useMemo(
    () => buildReviewBriefEntries(workspace?.documents ?? [], threads, proposals),
    [proposals, threads, workspace?.documents],
  );
  const resolvedCount = useMemo(
    () => threads.filter((thread) => thread.status === "resolved").length,
    [threads],
  );

  const loadBrief = useCallback(async () => {
    if (!workspaceRoot || !onRefreshReviewData) {
      return;
    }

    setErrorMessage(null);
    await onRefreshReviewData();
  }, [onRefreshReviewData, workspaceRoot]);

  const upsertBriefProposal = useCallback((proposal: ProposalRecord) => {
    upsertReviewProposal(proposal);
  }, [upsertReviewProposal]);

  const upsertBriefThread = useCallback((thread: ThreadRecord) => {
    upsertReviewThread(thread);
  }, [upsertReviewThread]);

  const refreshBriefThreads = useCallback(
    async (threadIds: string[]) => {
      if (!workspaceRoot || threadIds.length === 0) {
        return;
      }

      const uniqueThreadIds = [...new Set(threadIds)];
      const refreshedThreads = await Promise.all(
        uniqueThreadIds.map((threadId) =>
          invokeBackend<ThreadRecord>("load_thread", {
            threadId,
            workspaceRoot,
          }),
        ),
      );

      refreshedThreads.forEach(upsertReviewThread);
    },
    [upsertReviewThread, workspaceRoot],
  );

  const acceptProposal = useCallback(async (proposalId: string, updatedDocumentText?: string) => {
    if (!workspace) {
      return;
    }

    setActiveActionId(proposalId);
    setActiveActionKind("accept");
    setErrorMessage(null);

    try {
      const result = await invokeBackend<ProposalMutationResult>("accept_proposal", {
        proposalId,
        updatedDocumentText,
        workspaceRoot: workspace.rootPath,
      });
      upsertBriefProposal(result.proposal);
      if (result.document && result.document.id === activeDocument?.id) {
        onActiveDocumentApplied?.(result.document);
      }
      if (result.message) {
        setErrorMessage(result.message);
      }
      await refreshBriefThreads([
        ...result.proposal.threadIds,
        ...result.proposal.resolveThreadIds,
      ]);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to accept the selected proposal."));
    } finally {
      setActiveActionId(null);
      setActiveActionKind(null);
    }
  }, [
    activeDocument?.id,
    onActiveDocumentApplied,
    refreshBriefThreads,
    upsertBriefProposal,
    workspace,
  ]);

  const rejectProposal = useCallback(async (proposalId: string) => {
    if (!workspace) {
      return;
    }

    setActiveActionId(proposalId);
    setActiveActionKind("reject");
    setErrorMessage(null);

    try {
      const result = await invokeBackend<ProposalMutationResult>("reject_proposal", {
        proposalId,
        workspaceRoot: workspace.rootPath,
      });
      if (result.message) {
        setErrorMessage(result.message);
      }
      upsertBriefProposal(result.proposal);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to reject the selected proposal."));
    } finally {
      setActiveActionId(null);
      setActiveActionKind(null);
    }
  }, [upsertBriefProposal, workspace]);

  const replyToThread = useCallback(async (threadId: string, body: string) => {
    if (!workspace) {
      return;
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      return;
    }

    setActiveActionId(threadId);
    setActiveActionKind("reply");
    setErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("add_thread_message", {
        body: trimmedBody,
        kind: "reply",
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      if (thread.documentId === activeDocument?.id) {
        onActiveThreadUpdated?.(thread);
      }
      upsertBriefThread(thread);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to reply to the selected thread."));
    } finally {
      setActiveActionId(null);
      setActiveActionKind(null);
    }
  }, [activeDocument?.id, onActiveThreadUpdated, upsertBriefThread, workspace]);

  return useMemo(
    () => ({
      acceptProposal,
      activeActionId,
      activeActionKind,
      entries,
      errorMessage: errorMessage ?? reviewDataErrorMessage,
      isLoading,
      loadBrief,
      rejectProposal,
      replyToThread,
      resolvedCount,
    }),
    [
      acceptProposal,
      activeActionId,
      activeActionKind,
      entries,
      errorMessage,
      isLoading,
      loadBrief,
      rejectProposal,
      reviewDataErrorMessage,
      replyToThread,
      resolvedCount,
    ],
  );
}

export function buildReviewBriefEntries(
  documents: DocumentSummary[],
  threads: ThreadRecord[],
  proposals: ProposalRecord[],
): ReviewBriefEntry[] {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const entries: ReviewBriefEntry[] = [];

  proposals
    .filter((proposal) => proposal.status === "pending")
    .forEach((proposal) => {
      const document = documentsById.get(proposal.documentId);
      if (!document) {
        return;
      }

      const thread = proposal.threadIds
        .map((threadId) => threadsById.get(threadId))
        .find((candidate): candidate is ThreadRecord => Boolean(candidate));

      entries.push({
        agentSummary:
          excerpt(proposal.summary) ||
          excerpt(proposal.assistantMessage) ||
          "Pending proposal",
        anchorExcerpt: excerpt(thread?.anchor.quote ?? ""),
        document,
        id: `proposal:${proposal.id}`,
        isOlderVersion: proposal.baseContentHash !== document.currentContentHash,
        kind: "proposal",
        proposal,
        thread,
        updatedAt: proposal.updatedAt || proposal.createdAt,
      });
    });

  threads
    .filter((thread) => thread.status === "open" && !thread.reviewDone)
    .forEach((thread) => {
      const document = documentsById.get(thread.documentId);
      const latestAgentMessage = findLatestAgentMessage(thread);
      if (!document || !latestAgentMessage) {
        return;
      }

      entries.push({
        agentSummary: excerpt(latestAgentMessage.body) || "Agent reply",
        anchorExcerpt: excerpt(thread.anchor.quote),
        document,
        id: `thread:${thread.id}`,
        isOlderVersion:
          (thread.lastReanchorContentHash ?? thread.anchor.baseContentHash) !==
          document.currentContentHash,
        kind: "agent-thread",
        latestAgentMessage,
        thread,
        updatedAt: latestAgentMessage.createdAt || thread.updatedAt,
      });
    });

  return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function findLatestAgentMessage(thread: ThreadRecord) {
  const latestReviewMessage = [...thread.messages]
    .reverse()
    .find((message) => message.authorType !== "system");
  if (!latestReviewMessage) {
    return null;
  }

  return isAgentMessage(latestReviewMessage) ? latestReviewMessage : null;
}

function isAgentMessage(message: MessageRecord) {
  return (
    message.authorType === "agent" ||
    message.authorType === "assistant" ||
    Boolean(message.agentId)
  );
}

function excerpt(value: string, limit = 220) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}
