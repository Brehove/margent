import { memo, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { DocumentSummary } from "../../types/workspace";

export interface FileActionRequest {
  id: number;
  kind: "create" | "delete" | "rename";
  relativePath?: string | null;
}

interface FileBrowserProps {
  actionRequest?: FileActionRequest | null;
  activeRelativePath: string | null;
  documents: DocumentSummary[];
  isCollapsed: boolean;
  isRefreshing: boolean;
  onCreateDocument: (relativePath: string) => void;
  onDeleteDocument: (relativePath: string) => void;
  onRenameDocument: (fromRelativePath: string, toRelativePath: string) => void;
  onRevealDocument: (relativePath: string) => void;
  onSelectDocument: (relativePath: string) => void;
  onRefresh: () => void;
  onToggleCollapse: () => void;
  rootPath: string;
}

type DraftAction =
  | {
      errorMessage: string | null;
      kind: "create";
      value: string;
    }
  | {
      errorMessage: string | null;
      fromRelativePath: string;
      kind: "rename";
      value: string;
    };

export const FileBrowser = memo(function FileBrowser({
  actionRequest,
  activeRelativePath,
  documents,
  isCollapsed,
  isRefreshing,
  onCreateDocument,
  onDeleteDocument,
  onRenameDocument,
  onRevealDocument,
  onSelectDocument,
  onRefresh,
  onToggleCollapse,
  rootPath,
}: FileBrowserProps) {
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [draftAction, setDraftAction] = useState<DraftAction | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!actionRequest) {
      return;
    }

    switch (actionRequest.kind) {
      case "create":
        setDeleteCandidate(null);
        setDraftAction({ errorMessage: null, kind: "create", value: "Untitled.md" });
        break;
      case "delete":
        if (actionRequest.relativePath) {
          setDraftAction(null);
          setDeleteCandidate(actionRequest.relativePath);
        }
        break;
      case "rename":
        if (actionRequest.relativePath) {
          setDeleteCandidate(null);
          setDraftAction({
            errorMessage: null,
            fromRelativePath: actionRequest.relativePath,
            kind: "rename",
            value: actionRequest.relativePath,
          });
        }
        break;
    }
  }, [actionRequest]);

  useEffect(() => {
    if (!draftAction || !draftInputRef.current) {
      return;
    }

    draftInputRef.current.focus();
    draftInputRef.current.select();
  }, [draftAction]);

  if (isCollapsed) {
    return (
      <div className="workspace-rail">
        <button
          aria-expanded="false"
          aria-label="Show files pane"
          className="workspace-rail-tab"
          onClick={onToggleCollapse}
          title="Show files"
          type="button"
        >
          Files
        </button>
        <div aria-hidden="true" className="workspace-rail-ornament">
          §
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="panel-header" title={rootPath}>
        <div className="workspace-pane-heading">
          <h2>Files</h2>
          <span className="workspace-pane-count">
            {documents.length} markdown {documents.length === 1 ? "file" : "files"}
          </span>
        </div>
        <div className="panel-header-actions workspace-pane-actions">
          <button
            aria-expanded="true"
            aria-label="Hide files pane"
            className="ghost-button pane-toggle-button"
            onClick={onToggleCollapse}
            title="Hide files"
            type="button"
          >
            Hide
          </button>
          <button
            className="ghost-button file-refresh-button"
            disabled={isRefreshing}
            onClick={onRefresh}
            title="Refresh files"
          >
            Refresh
          </button>
          <button
            className="ghost-button file-new-button"
            disabled={isRefreshing}
            onClick={() => {
              setDeleteCandidate(null);
              setDraftAction({ errorMessage: null, kind: "create", value: "Untitled.md" });
            }}
            type="button"
          >
            New File
          </button>
        </div>
        {draftAction?.kind === "create" ? (
          <FileNameForm
            actionLabel="Create"
            draftAction={draftAction}
            inputRef={draftInputRef}
            onCancel={() => setDraftAction(null)}
            onSubmit={(relativePath) => {
              onCreateDocument(relativePath);
              setDraftAction(null);
            }}
            setDraftAction={setDraftAction}
          />
        ) : null}
      </header>

      {documents.length ? (
        <ul className="file-list">
          {documents.map((document) => (
            <li className="file-list-item" key={document.id}>
              <button
                className={`file-select-button ${
                  document.relativePath === activeRelativePath ? "active" : ""
                }`}
                onClick={() => onSelectDocument(document.relativePath)}
                type="button"
              >
                <span className="file-row">
                  <span className="file-row-title">{document.displayName}</span>
                  {document.relativePath !== document.displayName ? (
                    <span className="file-row-meta">{document.relativePath}</span>
                  ) : null}
                </span>
              </button>
              <div className="file-row-actions" aria-label={`${document.displayName} actions`}>
                <button
                  className="file-row-action"
                  disabled={isRefreshing}
                  onClick={() => onRevealDocument(document.relativePath)}
                  title="Reveal in Finder"
                  type="button"
                >
                  Reveal
                </button>
                <button
                  className="file-row-action"
                  disabled={isRefreshing}
                  onClick={() => {
                    setDeleteCandidate(null);
                    setDraftAction({
                      errorMessage: null,
                      fromRelativePath: document.relativePath,
                      kind: "rename",
                      value: document.relativePath,
                    });
                  }}
                  title="Rename file"
                  type="button"
                >
                  Rename
                </button>
                <button
                  className="file-row-action danger"
                  disabled={isRefreshing}
                  onClick={() => {
                    setDraftAction(null);
                    setDeleteCandidate(document.relativePath);
                  }}
                  title="Delete file"
                  type="button"
                >
                  Delete
                </button>
              </div>
              {draftAction?.kind === "rename" &&
              draftAction.fromRelativePath === document.relativePath ? (
                <FileNameForm
                  actionLabel="Rename"
                  draftAction={draftAction}
                  inputRef={draftInputRef}
                  onCancel={() => setDraftAction(null)}
                  onSubmit={(relativePath) => {
                    if (relativePath !== document.relativePath) {
                      onRenameDocument(document.relativePath, relativePath);
                    }
                    setDraftAction(null);
                  }}
                  setDraftAction={setDraftAction}
                />
              ) : null}
              {deleteCandidate === document.relativePath ? (
                <div className="file-delete-confirm" role="group" aria-label="Confirm delete file">
                  <span>Delete review data too?</span>
                  <button
                    className="file-row-action danger"
                    disabled={isRefreshing}
                    onClick={() => {
                      onDeleteDocument(document.relativePath);
                      setDeleteCandidate(null);
                    }}
                    type="button"
                  >
                    Delete
                  </button>
                  <button
                    className="file-row-action"
                    onClick={() => setDeleteCandidate(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="file-empty-state">
          <p>No Markdown files were found in this workspace yet.</p>
        </div>
      )}
    </>
  );
});

function FileNameForm({
  actionLabel,
  draftAction,
  inputRef,
  onCancel,
  onSubmit,
  setDraftAction,
}: {
  actionLabel: string;
  draftAction: DraftAction;
  inputRef: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onSubmit: (relativePath: string) => void;
  setDraftAction: (draftAction: DraftAction) => void;
}) {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    const result = normalizeMarkdownFileName(draftAction.value);
    if (!result.relativePath) {
      setDraftAction({ ...draftAction, errorMessage: result.errorMessage });
      return;
    }

    onSubmit(result.relativePath);
  };

  return (
    <form className="file-name-form" onSubmit={handleSubmit}>
      <input
        ref={inputRef}
        aria-label={`${actionLabel} Markdown file name`}
        className="file-name-input"
        onChange={(event) =>
          setDraftAction({
            ...draftAction,
            errorMessage: null,
            value: event.currentTarget.value,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        spellCheck={false}
        type="text"
        value={draftAction.value}
      />
      <button className="file-row-action" type="submit">
        {actionLabel}
      </button>
      <button className="file-row-action" onClick={onCancel} type="button">
        Cancel
      </button>
      {draftAction.errorMessage ? (
        <div className="file-name-error" role="alert">
          {draftAction.errorMessage}
        </div>
      ) : null}
    </form>
  );
}

function normalizeMarkdownFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      errorMessage: "Enter a file name.",
      relativePath: null,
    };
  }

  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    trimmed.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    return {
      errorMessage: "Use a workspace-relative Markdown path.",
      relativePath: null,
    };
  }

  const relativePath = /\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  if (!/\.(md|markdown)$/i.test(relativePath)) {
    return {
      errorMessage: "Use a .md or .markdown file.",
      relativePath: null,
    };
  }

  return {
    errorMessage: null,
    relativePath,
  };
}
