import { parseUnifiedDiff, type DiffLineKind } from "../../lib/diff";

interface ProposalDiffPreviewProps {
  diffText: string;
  editableLabel?: string;
  editableText?: string;
  isEditable?: boolean;
  onEditableTextChange?: (value: string) => void;
}

export function ProposalDiffPreview({
  diffText,
  editableLabel = "Edited proposal text",
  editableText,
  isEditable = false,
  onEditableTextChange,
}: ProposalDiffPreviewProps) {
  const parsedDiff = parseUnifiedDiff(diffText);
  const editablePane =
    isEditable && editableText !== undefined ? (
      <label className="proposal-edit-pane">
        <span>{editableLabel}</span>
        <textarea
          aria-label={editableLabel}
          className="proposal-edit-textarea"
          onChange={(event) => onEditableTextChange?.(event.target.value)}
          spellCheck={false}
          value={editableText}
        />
      </label>
    ) : null;

  if (!parsedDiff.hunks.length) {
    return (
      <div className="proposal-diff-preview">
        <pre className="proposal-diff-fallback">{diffText}</pre>
        {editablePane}
      </div>
    );
  }

  return (
    <div className="proposal-diff-preview">
      <header className="proposal-diff-header">
        <div>
          <p className="proposal-diff-paths">
            <span>{parsedDiff.beforeLabel}</span>
            <span className="proposal-diff-arrow" aria-hidden="true">
              -&gt;
            </span>
            <span>{parsedDiff.afterLabel}</span>
          </p>
          <p className="thread-helper-text">
            {parsedDiff.hunks.length} hunk{parsedDiff.hunks.length === 1 ? "" : "s"} in this
            proposal
          </p>
        </div>
        <div className="proposal-diff-totals">
          <span className="proposal-diff-total added">+{parsedDiff.additions}</span>
          <span className="proposal-diff-total removed">-{parsedDiff.removals}</span>
        </div>
      </header>

      <div className="proposal-diff-hunks">
        {parsedDiff.hunks.map((hunk) => (
          <section className="proposal-diff-hunk" key={hunk.rawHeader}>
            <div className="proposal-diff-hunk-header">
              <span>{hunk.header}</span>
              <div className="proposal-diff-hunk-stats">
                <span className="proposal-diff-total added">+{hunk.additions}</span>
                <span className="proposal-diff-total removed">-{hunk.removals}</span>
              </div>
            </div>

            <div className="proposal-diff-lines">
              {hunk.lines.map((line, lineIndex) => (
                <div
                  className={`proposal-diff-line ${line.kind}`}
                  key={`${hunk.rawHeader}-${line.kind}-${lineIndex}`}
                >
                  <span className="proposal-diff-line-number">
                    {formatLineNumber(line.oldLineNumber)}
                  </span>
                  <span className="proposal-diff-line-number">
                    {formatLineNumber(line.newLineNumber)}
                  </span>
                  <span className={`proposal-diff-line-marker ${line.kind}`}>
                    {resolveMarker(line.kind)}
                  </span>
                  <code className="proposal-diff-line-text">{line.text || " "}</code>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {editablePane}
    </div>
  );
}

function formatLineNumber(value: number | null) {
  return value === null ? "" : value.toString();
}

function resolveMarker(kind: DiffLineKind) {
  switch (kind) {
    case "added":
      return "+";
    case "removed":
      return "-";
    case "meta":
      return "!";
    case "context":
    default:
      return " ";
  }
}
