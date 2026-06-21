import { useCallback, useMemo, useState } from "react";
import { invokeBackend } from "../lib/backend";
import { getErrorMessage } from "../lib/errorMessage";
import { proposalsForDocument, useReviewDataStore } from "../stores/reviewDataStore";
import type { ProposalMutationResult, ProposalRecord } from "../types/proposal";
import type { DocumentPayload, WorkspaceSnapshot } from "../types/workspace";

interface UseProposalsOptions {
  activeDocument: DocumentPayload | null;
  onDocumentApplied?: (document: DocumentPayload) => void;
  workspace: WorkspaceSnapshot | null;
}

type ProposalActionKind = "accept" | "reject" | null;

export function useProposals({
  activeDocument,
  onDocumentApplied,
  workspace,
}: UseProposalsOptions) {
  const [activeActionKind, setActiveActionKind] = useState<ProposalActionKind>(null);
  const [activeActionProposalId, setActiveActionProposalId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isLoading = useReviewDataStore((state) => state.isLoading);
  const allProposals = useReviewDataStore((state) => state.proposals);
  const upsertReviewProposal = useReviewDataStore((state) => state.upsertProposal);
  const proposals = useMemo(
    () => proposalsForDocument(allProposals, activeDocument?.id),
    [activeDocument?.id, allProposals],
  );

  const acceptProposal = useCallback(async (proposalId: string, updatedDocumentText?: string) => {
    if (!workspace) {
      return;
    }

    setActiveActionKind("accept");
    setActiveActionProposalId(proposalId);
    setErrorMessage(null);

    try {
      const result = await invokeBackend<ProposalMutationResult>("accept_proposal", {
        proposalId,
        updatedDocumentText,
        workspaceRoot: workspace.rootPath,
      });
      upsertReviewProposal(result.proposal);

      if (result.document) {
        onDocumentApplied?.(result.document);
      }

      if (result.message) {
        setErrorMessage(result.message);
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to accept the selected proposal."));
    } finally {
      setActiveActionKind(null);
      setActiveActionProposalId(null);
    }
  }, [onDocumentApplied, upsertReviewProposal, workspace]);

  const rejectProposal = useCallback(async (proposalId: string) => {
    if (!workspace) {
      return;
    }

    setActiveActionKind("reject");
    setActiveActionProposalId(proposalId);
    setErrorMessage(null);

    try {
      const result = await invokeBackend<ProposalMutationResult>("reject_proposal", {
        proposalId,
        workspaceRoot: workspace.rootPath,
      });
      upsertReviewProposal(result.proposal);

      if (result.message) {
        setErrorMessage(result.message);
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to reject the selected proposal."));
    } finally {
      setActiveActionKind(null);
      setActiveActionProposalId(null);
    }
  }, [upsertReviewProposal, workspace]);

  const upsertProposal = useCallback((proposal: ProposalRecord) => {
    upsertReviewProposal(proposal);
  }, [upsertReviewProposal]);

  return useMemo(
    () => ({
      acceptProposal,
      activeActionKind,
      activeActionProposalId,
      errorMessage,
      isLoading,
      proposals,
      rejectProposal,
      setErrorMessage,
      upsertProposal,
    }),
    [
      acceptProposal,
      activeActionKind,
      activeActionProposalId,
      errorMessage,
      isLoading,
      proposals,
      rejectProposal,
      upsertProposal,
    ],
  );
}
