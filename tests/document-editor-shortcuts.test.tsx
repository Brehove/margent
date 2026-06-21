import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DocumentEditor } from "../src/components/editor/DocumentEditor";
import { APP_MENU_COMMANDS, APP_MENU_DOM_EVENT } from "../src/lib/appMenuCommands";
import { useUiStore } from "../src/stores/uiStore";
import type { CodeMirrorSession } from "../src/components/editor/useCodeMirror";
import type { ProposalRecord } from "../src/types/proposal";
import type { AnchorRecord, MessageRecord, ThreadRecord } from "../src/types/thread";
import type { DocumentPayload } from "../src/types/workspace";

const mockUseCodeMirror = vi.fn();

vi.mock("../src/components/editor/useCodeMirror", () => ({
  useCodeMirror: (...args: unknown[]) => mockUseCodeMirror(...args),
}));

function makeDocumentPayload(overrides: Partial<DocumentPayload> = {}): DocumentPayload {
  const document = {
    absolutePath: "/workspace/README.md",
    content: "# Test\n",
    createdAt: "2026-01-01T00:00:00Z",
    currentContentHash: "sha256:test",
    displayName: "README.md",
    frontmatterMode: "none",
    headingIndex: [],
    id: "doc-1",
    lastKnownLineEnding: "lf",
    relativePath: "README.md",
    updatedAt: "2026-01-01T00:00:00Z",
    wordCount: 2,
    ...overrides,
  };

  return {
    ...document,
    version: document.version ?? {
      contentHash: document.currentContentHash,
      modifiedNs: null,
      size: new TextEncoder().encode(document.content).length,
    },
  };
}

function makeSession(overrides: Partial<CodeMirrorSession> = {}): CodeMirrorSession {
  return {
    createMarkdownLink: vi.fn(),
    focus: vi.fn(),
    focusFootnoteDefinition: vi.fn(),
    getCharacterCount: vi.fn(() => 7),
    getContent: vi.fn(() => "# Saved from shortcut\n"),
    getRangeRect: vi.fn(() => null),
    getLineCount: vi.fn(() => 2),
    getRevision: vi.fn(() => 1),
    getSelectionSnapshot: vi.fn(() => null),
    isDirty: vi.fn(() => true),
    markClean: vi.fn(),
    openSearch: vi.fn(),
    removeMarkdownLink: vi.fn(),
    replaceContent: vi.fn(),
    scrollToLine: vi.fn(),
    updateFootnoteDefinition: vi.fn(),
    updateMarkdownLink: vi.fn(),
    ...overrides,
  };
}

const stubAnchor: AnchorRecord = {
  baseContentHash: "sha256:test",
  blockFingerprint: "sha256:test",
  confidence: 1,
  endColumn: 12,
  endLine: 1,
  endOffsetUtf16: 11,
  headingPath: [],
  prefixContext: "",
  quote: "hello world",
  startColumn: 1,
  startLine: 1,
  startOffsetUtf16: 0,
  state: "attached",
  suffixContext: "",
};

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    adapterId: null,
    agentId: null,
    authorName: "You",
    authorType: "user",
    body: "Please revise this.",
    createdAt: "2026-01-01T00:00:00Z",
    id: "message-1",
    kind: "comment",
    replyToMessageId: null,
    threadId: "thread-1",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    anchor: stubAnchor,
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "You",
    documentId: "doc-1",
    id: "thread-1",
    linkedProposalIds: [],
    messages: [makeMessage()],
    providerSessions: {},
    schemaVersion: 5,
    status: "open",
    tags: [],
    title: "Thread",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    adapterId: "claude",
    assistantMessage:
      "This is the full revision response with grammar notes, rationale, and enough text to prove it is not the shortened summary.",
    baseContentHash: "sha256:test",
    computedDiff: "",
    createdAt: "2026-01-01T00:00:00Z",
    documentId: "doc-1",
    errorMessage: null,
    id: "proposal-1",
    resolveThreadIds: [],
    responseMode: "proposal",
    schemaVersion: 1,
    status: "pending",
    stderr: null,
    summary: "This is the full revision response with grammar notes...",
    threadIds: ["thread-1"],
    unifiedDiff: null,
    updatedAt: "2026-01-01T00:00:00Z",
    updatedDocumentText: null,
    warnings: [],
    ...overrides,
  };
}

describe("DocumentEditor keyboard shortcuts", () => {
  beforeEach(() => {
    mockUseCodeMirror.mockReset();
    useUiStore.setState({
      editorMode: "rendered",
      isFocusModeEnabled: false,
      isWorkspacePaneCollapsed: false,
      preferredAgentProvider: "codex",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves the active document on Cmd+S", () => {
    const onSave = vi.fn();
    const session = makeSession();

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: true,
        revision: 1,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={onSave}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", metaKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("# Saved from shortcut\n");
  });

  it("does not save on Cmd+S when the document is already clean", () => {
    const onSave = vi.fn();
    const session = makeSession({
      isDirty: vi.fn(() => false),
    });

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={onSave}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", metaKey: true });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Saved")).toBeInTheDocument();
  });

  it("autosaves the active dirty document after an idle revision window", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const session = makeSession({
      getContent: vi.fn(() => "# Autosaved\n"),
    });
    const baseProps = {
      addReply: vi.fn(async () => {}),
      createThreadFromSelection: vi.fn(async () => {}),
      deleteThread: vi.fn(async () => {}),
      document: makeDocumentPayload(),
      isSaving: false,
      isThreadSaving: false,
      loadThread: vi.fn(async () => null),
      onDirtyChange: vi.fn(),
      onSave,
      onThreadSelect: vi.fn(),
      reopenThread: vi.fn(async () => {}),
      resolveThread: vi.fn(async () => {}),
      threads: [],
    };

    mockUseCodeMirror
      .mockReturnValueOnce({
        session,
        sessionMetrics: {
          characterCount: 7,
          lineCount: 2,
        },
        sessionSnapshot: {
          isDirty: true,
          revision: 1,
        },
        setHostElement: vi.fn(),
      })
      .mockReturnValueOnce({
        session,
        sessionMetrics: {
          characterCount: 7,
          lineCount: 2,
        },
        sessionSnapshot: {
          isDirty: true,
          revision: 2,
        },
        setHostElement: vi.fn(),
      })
      .mockReturnValue({
        session,
        sessionMetrics: {
          characterCount: 7,
          lineCount: 2,
        },
        sessionSnapshot: {
          isDirty: true,
          revision: 2,
        },
        setHostElement: vi.fn(),
      });

    const { rerender } = render(<DocumentEditor {...baseProps} />);

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(onSave).not.toHaveBeenCalled();

    rerender(
      <DocumentEditor
        {...baseProps}
        document={makeDocumentPayload({ updatedAt: "2026-01-01T00:00:01Z" })}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onSave).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("# Autosaved\n");
  });

  it("does not replace newer dirty edits with an older same-document save response", () => {
    const session = makeSession({
      getContent: vi.fn(() => "# Saved\n\nNewer unsaved edit.\n"),
      isDirty: vi.fn(() => true),
    });

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: true,
        revision: 2,
      },
      setHostElement: vi.fn(),
    });

    const baseProps = {
      addReply: vi.fn(async () => {}),
      createThreadFromSelection: vi.fn(async () => {}),
      deleteThread: vi.fn(async () => {}),
      document: makeDocumentPayload({
        content: "# Saved\n",
        currentContentHash: "sha256:saved",
      }),
      isSaving: false,
      isThreadSaving: false,
      loadThread: vi.fn(async () => null),
      onDirtyChange: vi.fn(),
      onSave: vi.fn(),
      onThreadSelect: vi.fn(),
      reopenThread: vi.fn(async () => {}),
      resolveThread: vi.fn(async () => {}),
      threads: [],
    };

    const { rerender } = render(<DocumentEditor {...baseProps} />);
    expect(session.replaceContent).toHaveBeenCalledWith("# Saved\n");
    vi.mocked(session.replaceContent).mockClear();

    rerender(
      <DocumentEditor
        {...baseProps}
        document={makeDocumentPayload({
          content: "# Saved\n\nOlder save response.\n",
          currentContentHash: "sha256:older-save-response",
        })}
      />,
    );

    expect(session.replaceContent).not.toHaveBeenCalled();
  });

  it("marks a matching same-document save response clean", () => {
    const session = makeSession({
      getContent: vi.fn(() => "# Saved\n\nCurrent edit.\n"),
      isDirty: vi.fn(() => true),
    });

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: true,
        revision: 2,
      },
      setHostElement: vi.fn(),
    });

    const baseProps = {
      addReply: vi.fn(async () => {}),
      createThreadFromSelection: vi.fn(async () => {}),
      deleteThread: vi.fn(async () => {}),
      document: makeDocumentPayload({
        content: "# Saved\n",
        currentContentHash: "sha256:saved",
      }),
      isSaving: false,
      isThreadSaving: false,
      loadThread: vi.fn(async () => null),
      onDirtyChange: vi.fn(),
      onSave: vi.fn(),
      onThreadSelect: vi.fn(),
      reopenThread: vi.fn(async () => {}),
      resolveThread: vi.fn(async () => {}),
      threads: [],
    };

    const { rerender } = render(<DocumentEditor {...baseProps} />);
    vi.mocked(session.replaceContent).mockClear();

    rerender(
      <DocumentEditor
        {...baseProps}
        document={makeDocumentPayload({
          content: "# Saved\n\nCurrent edit.\n",
          currentContentHash: "sha256:current-edit",
        })}
      />,
    );

    expect(session.replaceContent).toHaveBeenCalledWith("# Saved\n\nCurrent edit.\n", {
      preserveViewport: true,
    });
  });

  it("opens editor search from the Find button", () => {
    const session = makeSession();

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    expect(session.openSearch).toHaveBeenCalledTimes(1);
  });

  it("opens editor search on Cmd+F", () => {
    const session = makeSession();

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    fireEvent.keyDown(window, { key: "f", metaKey: true });

    expect(session.openSearch).toHaveBeenCalledTimes(1);
  });

  it("toggles focus mode from the editor toolbar", () => {
    mockUseCodeMirror.mockReturnValue({
      session: makeSession({ isDirty: vi.fn(() => false) }),
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    const focusButton = screen.getByRole("button", { name: "Focus" });
    expect(focusButton).toHaveAttribute("aria-pressed", "false");
    expect(mockUseCodeMirror).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isFocusModeEnabled: false,
      }),
    );

    fireEvent.click(focusButton);

    expect(useUiStore.getState().isFocusModeEnabled).toBe(true);
    expect(screen.getByRole("button", { name: "Focus" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mockUseCodeMirror).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isFocusModeEnabled: true,
      }),
    );
  });

  it("scrolls to a project search navigation request", async () => {
    const session = makeSession({
      scrollToLine: vi.fn(),
    });

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        navigationRequest={{
          id: 1,
          line: 7,
          relativePath: "README.md",
        }}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    await waitFor(() => {
      expect(session.scrollToLine).toHaveBeenCalledWith(7);
    });
  });

  it("jumps to headings from the document outline", () => {
    const session = makeSession();

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 12,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload({
          headingIndex: [
            { depth: 1, line: 1, text: "Chapter One" },
            { depth: 2, line: 12, text: "Chapter Two" },
          ],
        })}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Outline" }));

    const headingButton = screen.getByText("Chapter Two").closest("button");
    expect(headingButton).not.toBeNull();

    fireEvent.click(headingButton!);

    expect(session.scrollToLine).toHaveBeenCalledTimes(1);
    expect(session.scrollToLine).toHaveBeenCalledWith(12);
  });

  it("saves the active document from the native menu command", () => {
    const onSave = vi.fn();
    const session = makeSession();

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: true,
        revision: 1,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={onSave}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    window.dispatchEvent(
      new CustomEvent(APP_MENU_DOM_EVENT, { detail: APP_MENU_COMMANDS.save }),
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("# Saved from shortcut\n");
  });

  it("opens editor search from the native menu command", () => {
    const session = makeSession();

    mockUseCodeMirror.mockReturnValue({
      session,
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    window.dispatchEvent(
      new CustomEvent(APP_MENU_DOM_EVENT, { detail: APP_MENU_COMMANDS.find }),
    );

    expect(session.openSearch).toHaveBeenCalledTimes(1);
  });

  it("opens the full proposal response when the selected thread is expanded", () => {
    mockUseCodeMirror.mockReturnValue({
      session: makeSession({ isDirty: vi.fn(() => false) }),
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        proposals={[makeProposal()]}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        selectedThreadId="thread-1"
        threads={[makeThread()]}
      />,
    );

    const responseDetails = screen.getByText("Agent response").closest("details");
    expect(responseDetails).not.toHaveAttribute("open");

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));

    expect(responseDetails).toHaveAttribute("open");
    expect(responseDetails).toHaveTextContent(
      "This is the full revision response with grammar notes, rationale",
    );
  });

  it("shows document proposals in the Changes tab", () => {
    mockUseCodeMirror.mockReturnValue({
      session: makeSession({ isDirty: vi.fn(() => false) }),
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        proposals={[makeProposal({ summary: "Tighten the introduction." })]}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    expect(screen.getByText("Tighten the introduction.")).toBeInTheDocument();
    expect(screen.getByText("1 proposal")).toBeInTheDocument();
  });

  it("uses one thread composer for comments and provider instructions", async () => {
    const addReply = vi.fn(async () => {});
    const onRunProviderThreadAction = vi.fn(async () => {});

    mockUseCodeMirror.mockReturnValue({
      session: makeSession({ isDirty: vi.fn(() => false) }),
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={addReply}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onRunProviderThreadAction={onRunProviderThreadAction}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        reviewPasses={[{ name: "voice", title: "Voice" }]}
        resolveThread={vi.fn(async () => {})}
        selectedReviewPassName="voice"
        selectedThreadId="thread-1"
        threads={[makeThread()]}
      />,
    );

    expect(
      screen.queryByPlaceholderText("Optional instruction for Codex or Claude Code..."),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Comment..."), {
      target: { value: "Please check this with Claude." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => {
      expect(addReply).toHaveBeenCalledWith("thread-1", "Please check this with Claude.");
    });
    expect(onRunProviderThreadAction).toHaveBeenCalledWith(
      "claude",
      "feedback",
      "thread-1",
      "Please check this with Claude.",
      "voice",
    );
    expect(useUiStore.getState().preferredAgentProvider).toBe("claude");
  });

  it("runs a provider on an existing thread when the composer is empty", async () => {
    const addReply = vi.fn(async () => {});
    const onRunProviderThreadAction = vi.fn(async () => {});

    mockUseCodeMirror.mockReturnValue({
      session: makeSession({ isDirty: vi.fn(() => false) }),
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={addReply}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onRunProviderThreadAction={onRunProviderThreadAction}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        selectedThreadId="thread-1"
        threads={[makeThread()]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Revise" }));

    await waitFor(() => {
      expect(onRunProviderThreadAction).toHaveBeenCalledWith(
        "codex",
        "revise",
        "thread-1",
        "",
        null,
      );
    });
    expect(addReply).not.toHaveBeenCalled();
  });

  it("creates whole-document comments from the unified document composer", async () => {
    const createDocumentThread = vi.fn(async () => {});

    mockUseCodeMirror.mockReturnValue({
      session: makeSession({ isDirty: vi.fn(() => false) }),
      sessionMetrics: {
        characterCount: 7,
        lineCount: 2,
      },
      sessionSnapshot: {
        isDirty: false,
        revision: 0,
      },
      setHostElement: vi.fn(),
    });

    render(
      <DocumentEditor
        addReply={vi.fn(async () => {})}
        createDocumentThread={createDocumentThread}
        createThreadFromSelection={vi.fn(async () => {})}
        deleteThread={vi.fn(async () => {})}
        document={makeDocumentPayload()}
        isSaving={false}
        isThreadSaving={false}
        loadThread={vi.fn(async () => null)}
        onDirtyChange={vi.fn()}
        onSave={vi.fn()}
        onThreadSelect={vi.fn()}
        reopenThread={vi.fn(async () => {})}
        resolveThread={vi.fn(async () => {})}
        threads={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Whole Document/ }));
    fireEvent.change(screen.getByPlaceholderText("Comment on the whole document..."), {
      target: { value: "Look at the whole draft arc." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      expect(createDocumentThread).toHaveBeenCalledWith("Look at the whole draft arc.");
    });
  });
});
