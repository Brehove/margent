import { memo, useEffect, useState } from "react";
import { ProposalDiffPreview } from "../editor/ProposalDiffPreview";
import type { ReviewBriefEntry } from "../../types/reviewBrief";

interface ReviewBriefViewProps {
  activeActionId: string | null;
  activeActionKind: "accept" | "reject" | "reply" | null;
  entries: ReviewBriefEntry[];
  errorMessage: string | null;
  isLoading: boolean;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onOpenThread: (relativePath: string, threadId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
  resolvedCount: number;
}

export const ReviewBriefView = memo(function ReviewBriefView({
  activeActionId,
  activeActionKind,
  entries,
  errorMessage,
  isLoading,
  onAcceptProposal,
  onOpenThread,
  onRefresh,
  onRejectProposal,
  onReplyToThread,
  resolvedCount,
}: ReviewBriefViewProps) {
  return (
    <section className="review-brief-view" aria-label="Review Brief">
      <header className="review-brief-header">
        <div>
          <p className="eyebrow-lbl">Review Brief</p>
          <h1>Workspace Review Queue</h1>
        </div>
        <button className="ghost-button" disabled={isLoading} onClick={() => void onRefresh()}>
          {isLoading ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {errorMessage ? <p className="proposal-error-text">{errorMessage}</p> : null}

      <div className="review-brief-stack">
        {entries.length === 0 && !isLoading ? (
          <div className="review-brief-empty">No pending proposals or unanswered agent replies.</div>
        ) : null}
        {entries.map((entry) =>
          entry.kind === "proposal" && entry.proposal ? (
            <ReviewBriefProposalCard
              activeActionId={activeActionId}
              activeActionKind={activeActionKind}
              entry={entry}
              key={entry.id}
              onAcceptProposal={onAcceptProposal}
              onOpenThread={onOpenThread}
              onRejectProposal={onRejectProposal}
            />
          ) : entry.thread ? (
            <ReviewBriefThreadCard
              activeActionId={activeActionId}
              activeActionKind={activeActionKind}
              entry={entry}
              key={entry.id}
              onOpenThread={onOpenThread}
              onReplyToThread={onReplyToThread}
            />
          ) : null,
        )}
      </div>

      <details className="review-brief-resolved">
        <summary>Resolved ({resolvedCount})</summary>
      </details>
    </section>
  );
});

const ReviewBriefProposalCard = memo(function ReviewBriefProposalCard({
  activeActionId,
  activeActionKind,
  entry,
  onAcceptProposal,
  onOpenThread,
  onRejectProposal,
}: {
  activeActionId: string | null;
  activeActionKind: "accept" | "reject" | "reply" | null;
  entry: ReviewBriefEntry;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onOpenThread: (relativePath: string, threadId: string) => Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
}) {
  const proposal = entry.proposal;
  const [editedDocumentText, setEditedDocumentText] = useState(
    proposal?.updatedDocumentText ?? "",
  );

  useEffect(() => {
    setEditedDocumentText(proposal?.updatedDocumentText ?? "");
  }, [proposal?.id, proposal?.updatedDocumentText]);

  if (!proposal) {
    return null;
  }

  const isAccepting = activeActionKind === "accept" && activeActionId === proposal.id;
  const isRejecting = activeActionKind === "reject" && activeActionId === proposal.id;
  const editedOverride =
    proposal.updatedDocumentText !== null && editedDocumentText !== proposal.updatedDocumentText
      ? editedDocumentText
      : undefined;

  return (
    <article
      className="review-brief-card"
      data-brief-kind="proposal"
      data-doc-path={entry.document.relativePath}
      data-proposal-id={proposal.id}
      data-thread-id={entry.thread?.id ?? undefined}
    >
      <div className="review-brief-card-head">
        <div>
          <p className="eyebrow-lbl">Proposal · {proposal.adapterId}</p>
          <h2>{entry.document.relativePath}</h2>
        </div>
        <span className={`proposal-status-pill ${proposal.status}`}>{proposal.status}</span>
      </div>
      {entry.isOlderVersion ? (
        <p className="review-brief-version-warning">Applies to an older document version.</p>
      ) : null}
      {entry.anchorExcerpt ? <p className="review-brief-anchor">{entry.anchorExcerpt}</p> : null}
      <p className="review-brief-summary">{entry.agentSummary}</p>
      {proposal.computedDiff ? (
        <details className="proposal-details">
          <summary>Diff preview</summary>
          <ProposalDiffPreview
            diffText={proposal.computedDiff}
            editableText={
              proposal.updatedDocumentText !== null ? editedDocumentText : undefined
            }
            isEditable={proposal.updatedDocumentText !== null}
            onEditableTextChange={setEditedDocumentText}
          />
        </details>
      ) : null}
      <div className="proposal-actions">
        <button
          className="primary-button"
          disabled={isAccepting || isRejecting || entry.isOlderVersion}
          onClick={() => void onAcceptProposal(proposal.id, editedOverride)}
        >
          {isAccepting ? "Accepting..." : "Accept"}
        </button>
        <button
          className="ghost-button"
          disabled={isAccepting || isRejecting}
          onClick={() => void onRejectProposal(proposal.id)}
        >
          {isRejecting ? "Rejecting..." : "Reject"}
        </button>
        {entry.thread ? (
          <button
            className="ghost-button"
            onClick={() => void onOpenThread(entry.document.relativePath, entry.thread!.id)}
          >
            Open Thread
          </button>
        ) : null}
      </div>
    </article>
  );
});

const ReviewBriefThreadCard = memo(function ReviewBriefThreadCard({
  activeActionId,
  activeActionKind,
  entry,
  onOpenThread,
  onReplyToThread,
}: {
  activeActionId: string | null;
  activeActionKind: "accept" | "reject" | "reply" | null;
  entry: ReviewBriefEntry;
  onOpenThread: (relativePath: string, threadId: string) => Promise<void>;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
}) {
  const thread = entry.thread;
  const [replyBody, setReplyBody] = useState("");

  if (!thread) {
    return null;
  }

  const isReplying = activeActionKind === "reply" && activeActionId === thread.id;

  return (
    <article
      className="review-brief-card"
      data-brief-kind="agent-thread"
      data-doc-path={entry.document.relativePath}
      data-thread-id={thread.id}
    >
      <div className="review-brief-card-head">
        <div>
          <p className="eyebrow-lbl">Agent Reply · {entry.latestAgentMessage?.authorName}</p>
          <h2>{entry.document.relativePath}</h2>
        </div>
        <span className="proposal-status-pill pending">open</span>
      </div>
      {entry.isOlderVersion ? (
        <p className="review-brief-version-warning">Applies to an older document version.</p>
      ) : null}
      <p className="review-brief-thread-title">{thread.title}</p>
      {entry.anchorExcerpt ? <p className="review-brief-anchor">{entry.anchorExcerpt}</p> : null}
      <p className="review-brief-summary">{entry.agentSummary}</p>
      <textarea
        aria-label={`Reply to ${thread.title}`}
        className="thread-textarea review-brief-reply"
        onChange={(event) => setReplyBody(event.currentTarget.value)}
        placeholder="Reply..."
        value={replyBody}
      />
      <div className="proposal-actions">
        <button
          className="primary-button"
          disabled={!replyBody.trim() || isReplying}
          onClick={() => {
            void onReplyToThread(thread.id, replyBody).then(() => setReplyBody(""));
          }}
        >
          {isReplying ? "Replying..." : "Reply"}
        </button>
        <button
          className="ghost-button"
          onClick={() => void onOpenThread(entry.document.relativePath, thread.id)}
        >
          Open Thread
        </button>
      </div>
    </article>
  );
});
