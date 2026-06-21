import { useCallback, useEffect, useMemo, useState } from "react";
import { invokeBackend } from "../lib/backend";
import { getErrorMessage } from "../lib/errorMessage";
import type { ProposalMutationResult, ProposalRecord } from "../types/proposal";
import type { DocumentPayload, WorkspaceSnapshot } from "../types/workspace";

interface UseProposalsOptions {
  activeDocument: DocumentPayload | null;
  externalDocument: DocumentPayload | null;
  onDocumentApplied?: (document: DocumentPayload) => void;
  workspace: WorkspaceSnapshot | null;
}

type ProposalActionKind = "accept" | "reject" | null;

export function useProposals({
  activeDocument,
  externalDocument,
  onDocumentApplied,
  workspace,
}: UseProposalsOptions) {
  const [activeActionKind, setActiveActionKind] = useState<ProposalActionKind>(null);
  const [activeActionProposalId, setActiveActionProposalId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);

  useEffect(() => {
    if (!workspace || !activeDocument) {
      setProposals([]);
      return;
    }

    void loadProposals(workspace.rootPath, activeDocument.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeDocument?.currentContentHash,
    activeDocument?.id,
    externalDocument?.currentContentHash,
    workspace?.rootPath,
  ]);

  const loadProposals = useCallback(async (
    workspaceRoot = workspace?.rootPath,
    documentId = activeDocument?.id,
  ) => {
    if (!workspaceRoot || !documentId) {
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const nextProposals = await invokeBackend<ProposalRecord[]>("load_proposals", {
        documentId,
        workspaceRoot,
      });
      setProposals(nextProposals);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to load proposal records."));
    } finally {
      setIsLoading(false);
    }
  }, [activeDocument?.id, workspace?.rootPath]);

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
      upsertProposal(result.proposal);

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
  }, [onDocumentApplied, workspace]);

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
      upsertProposal(result.proposal);

      if (result.message) {
        setErrorMessage(result.message);
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to reject the selected proposal."));
    } finally {
      setActiveActionKind(null);
      setActiveActionProposalId(null);
    }
  }, [workspace]);

  const upsertProposal = useCallback((proposal: ProposalRecord) => {
    setProposals((current) =>
      sortProposals([proposal, ...current.filter((entry) => entry.id !== proposal.id)]),
    );
  }, []);

  return useMemo(
    () => ({
      acceptProposal,
      activeActionKind,
      activeActionProposalId,
      errorMessage,
      isLoading,
      loadProposals,
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
      loadProposals,
      proposals,
      rejectProposal,
      upsertProposal,
    ],
  );
}

function sortProposals(proposals: ProposalRecord[]) {
  return [...proposals].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
