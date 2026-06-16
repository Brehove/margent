import {
  memo,
  type CSSProperties,
  type FormEvent,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { EditorSelectionSnapshot, MessageRecord, ThreadRecord } from "../../types/thread";
import type { ProposalRecord } from "../../types/proposal";
import type { ReviewPassSummary } from "../../types/reviewPass";
import type { DocumentPayload, HeadingIndexEntry } from "../../types/workspace";
import {
  APP_MENU_COMMANDS,
  APP_MENU_DOM_EVENT,
  isAppMenuCommand,
} from "../../lib/appMenuCommands";
import { convertLocalFileSrc, isDesktopBackend } from "../../lib/backend";
import { measurePerf } from "../../lib/devPerf";
import {
  COMMENT_DOCK_MAX_WIDTH,
  COMMENT_DOCK_MIN_WIDTH,
  useUiStore,
  type EditorMode,
  type PreferredAgentProvider,
} from "../../stores/uiStore";
import {
  useCodeMirror,
  type ActiveFootnoteDefinition,
  type ActiveMarkdownLink,
} from "./useCodeMirror";
import { ProposalDiffPreview } from "./ProposalDiffPreview";
import { invokeBackend } from "../../lib/backend";

type AgentProviderId = PreferredAgentProvider;
type ProviderThreadActionKind = "feedback" | "revise";
type ProviderDocumentActionKind = "feedback" | "revise";

interface ProviderActionState {
  action: ProviderThreadActionKind | null;
  errorMessage: string | null;
  provider: AgentProviderId | null;
  runId: string | null;
  streamedText: string;
  threadId: string | null;
}

interface ProviderDocumentActionState {
  action: ProviderDocumentActionKind | null;
  documentId: string | null;
  errorMessage: string | null;
  provider: AgentProviderId | null;
  runId: string | null;
  streamedText: string;
}

interface DocumentEditorProps {
  addReply: (threadId: string, body: string) => Promise<void>;
  createDocumentThread?: (body: string) => Promise<void>;
  createThreadFromSelection: (
    body: string,
    selection: EditorSelectionSnapshot,
    content: string,
  ) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  document: DocumentPayload | null;
  isSaving: boolean;
  isThreadSaving: boolean;
  importImageAsset?: (file: File) => Promise<string>;
  loadThread: (threadId: string | null) => Promise<ThreadRecord | null>;
  navigationRequest?: {
    id: number;
    line: number;
    relativePath: string;
  } | null;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onCancelProviderRun: (runId: string | null) => Promise<void>;
  onDirtyChange: (isDirty: boolean) => void;
  onFocusModeTypingActivity?: () => void;
  onRejectProposal: (proposalId: string) => Promise<void>;
  onRunProviderDocumentAction: (
    provider: AgentProviderId,
    action: ProviderDocumentActionKind,
    instruction: string,
    passName: string | null,
  ) => Promise<void>;
  onRunProviderThreadAction: (
    provider: AgentProviderId,
    action: ProviderThreadActionKind,
    threadId: string,
    instruction: string,
    passName: string | null,
  ) => Promise<void>;
  onSave: (content: string) => void;
  onThreadSelect: (threadId: string | null) => void;
  providerActionState: ProviderActionState;
  providerDocumentActionState: ProviderDocumentActionState;
  proposalActionKind: "accept" | "reject" | null;
  proposalActionProposalId: string | null;
  proposalErrorMessage: string | null;
  proposals: ProposalRecord[];
  reopenThread: (threadId: string) => Promise<void>;
  reviewPasses?: ReviewPassSummary[];
  resolveThread: (threadId: string) => Promise<void>;
  selectedThreadId?: string | null;
  selectedReviewPassName?: string | null;
  setSelectedReviewPassName?: (passName: string | null) => void;
  threads: ThreadRecord[];
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});
const AUTOSAVE_IDLE_DELAY_MS = 1800;

interface LinkEditorFrame {
  left: number;
  placement: "above" | "below";
  top: number;
}

const LINK_POPOVER_HALF_WIDTH = 240;
const LINK_POPOVER_MARGIN = 14;
const THREAD_MESSAGE_LINK_PATTERN =
  /\[([^\]\r\n]+)\]\((<https?:\/\/[^>\r\n]+>|https?:\/\/[^\s)\r\n]+)(?:\s+["'][^)\r\n]*["'])?\)|https?:\/\/[^\s<]+/g;
const emptyProviderActionState: ProviderActionState = {
  action: null,
  errorMessage: null,
  provider: null,
  runId: null,
  streamedText: "",
  threadId: null,
};
const emptyProviderDocumentActionState: ProviderDocumentActionState = {
  action: null,
  documentId: null,
  errorMessage: null,
  provider: null,
  runId: null,
  streamedText: "",
};
const noopProposalAction = async () => {};
const noopCreateDocumentThread = async () => {};
const noopProviderThreadAction = async () => {};
const noopProviderDocumentAction = async () => {};
const noopCancelProviderRun = async () => {};
const noopReviewPassChange = () => {};

type ThreadMessageBodySegment =
  | {
      kind: "text";
      text: string;
    }
  | {
      href: string;
      kind: "link";
      text: string;
    };

export const DocumentEditor = memo(function DocumentEditor({
  addReply,
  createDocumentThread = noopCreateDocumentThread,
  createThreadFromSelection,
  deleteThread,
  document,
  isSaving,
  isThreadSaving,
  importImageAsset,
  loadThread,
  navigationRequest = null,
  onAcceptProposal = noopProposalAction,
  onCancelProviderRun = noopCancelProviderRun,
  onDirtyChange,
  onFocusModeTypingActivity,
  onRejectProposal = noopProposalAction,
  onRunProviderDocumentAction = noopProviderDocumentAction,
  onRunProviderThreadAction = noopProviderThreadAction,
  onSave,
  onThreadSelect,
  providerActionState = emptyProviderActionState,
  providerDocumentActionState = emptyProviderDocumentActionState,
  proposalActionKind = null,
  proposalActionProposalId = null,
  proposalErrorMessage = null,
  proposals = [],
  reopenThread,
  reviewPasses = [],
  resolveThread,
  selectedReviewPassName = null,
  selectedThreadId = null,
  setSelectedReviewPassName = noopReviewPassChange,
  threads,
}: DocumentEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dockBodyRef = useRef<HTMLDivElement | null>(null);
  const activeMarkerRef = useRef<HTMLElement | null>(null);
  const activeThreadCardRef = useRef<HTMLElement | null>(null);
  const createCardRef = useRef<HTMLElement | null>(null);
  const createAnchorRectRef = useRef<DOMRect | null>(null);
  const loadThreadRef = useRef(loadThread);
  const [replyBody, setReplyBody] = useState("");
  const [documentAgentPrompt, setDocumentAgentPrompt] = useState("");
  const [isDocumentAgentExpanded, setIsDocumentAgentExpanded] = useState(false);
  const [newCommentBody, setNewCommentBody] = useState("");
  const [createSelection, setCreateSelection] = useState<EditorSelectionSnapshot | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadRecord | null>(null);
  const [isThreadDetailLoading, setIsThreadDetailLoading] = useState(false);
  const [threadDetailError, setThreadDetailError] = useState<string | null>(null);
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [threadCardOffset, setThreadCardOffset] = useState(0);
  const [createCardOffset, setCreateCardOffset] = useState(0);
  const [activeFootnoteDefinition, setActiveFootnoteDefinition] =
    useState<ActiveFootnoteDefinition | null>(null);
  const [footnoteEditorLabel, setFootnoteEditorLabel] = useState("");
  const [footnoteEditorContent, setFootnoteEditorContent] = useState("");
  const [activeLink, setActiveLink] = useState<ActiveMarkdownLink | null>(null);
  const [pendingLinkSelection, setPendingLinkSelection] =
    useState<EditorSelectionSnapshot | null>(null);
  const [linkEditorLabel, setLinkEditorLabel] = useState("");
  const [linkEditorUrl, setLinkEditorUrl] = useState("");
  const [linkEditorTitle, setLinkEditorTitle] = useState("");
  const [linkEditorFrame, setLinkEditorFrame] = useState<LinkEditorFrame | null>(null);
  const [isResizingCommentDock, setIsResizingCommentDock] = useState(false);
  const commentDockWidth = useUiStore((state) => state.commentDockWidth);
  const editorMode = useUiStore((state) => state.editorMode);
  const isDocumentOutlineVisible = useUiStore((state) => state.isDocumentOutlineVisible);
  const isFocusModeEnabled = useUiStore((state) => state.isFocusModeEnabled);
  const preferredAgentProvider = useUiStore((state) => state.preferredAgentProvider);
  const setCommentDockWidth = useUiStore((state) => state.setCommentDockWidth);
  const setEditorMode = useUiStore((state) => state.setEditorMode);
  const toggleDocumentOutline = useUiStore((state) => state.toggleDocumentOutline);
  const toggleFocusMode = useUiStore((state) => state.toggleFocusMode);
  const setPreferredAgentProvider = useUiStore((state) => state.setPreferredAgentProvider);

  const { session, sessionMetrics, sessionSnapshot, setHostElement } = useCodeMirror({
    editorMode,
    isFocusModeEnabled,
    onActiveFootnoteDefinitionChange: setActiveFootnoteDefinition,
    onActiveLinkChange: setActiveLink,
    onCreateLinkRequested: handleCreateLinkRequested,
    onFocusModeTypingActivity,
    onImportImageAsset: importImageAsset,
    initialValue: document?.content ?? "",
    resolveMarkdownImageSource: (source) => resolveDocumentImageSource(source, document),
    onSaveRequested: onSave,
    onSelectionChange: handleSelectionChange,
    onThreadSelect,
    selectedThreadId,
    threads,
  });
  const isDirty = sessionSnapshot.isDirty;
  const lineCount = sessionMetrics.lineCount;
  const characterCount = sessionMetrics.characterCount;

  function handleSelectionChange(selection: EditorSelectionSnapshot | null) {
    if (!selection || !hostRef.current) {
      createAnchorRectRef.current = null;
      setCreateSelection(null);
      setNewCommentBody("");
      return;
    }

    const domSelection = window.getSelection();
    const range =
      domSelection && domSelection.rangeCount > 0 ? domSelection.getRangeAt(0) : null;
    if (!range || !hostRef.current.contains(range.commonAncestorContainer)) {
      createAnchorRectRef.current = null;
      setCreateSelection(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      createAnchorRectRef.current = null;
      setCreateSelection(null);
      return;
    }

    createAnchorRectRef.current = rect;
    setCreateSelection(selection);
    onThreadSelect(null);
  }

  function handleCreateLinkRequested(selection: EditorSelectionSnapshot) {
    createAnchorRectRef.current = null;
    setCreateSelection(null);
    setNewCommentBody("");
    setPendingLinkSelection(selection);
    setLinkEditorLabel(selection.quote);
    setLinkEditorUrl("");
    setLinkEditorTitle("");
    onThreadSelect(null);
  }

  const setEditorHost = useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      setHostElement(node);
    },
    [setHostElement],
  );
  const selectedThreadSummary =
    selectedThreadId ? threads.find((thread) => thread.id === selectedThreadId) ?? null : null;
  const activeThread =
    threadDetail && threadDetail.id === selectedThreadId ? threadDetail : selectedThreadSummary;
  const isActiveThreadExpanded = activeThread ? expandedThreadId === activeThread.id : false;
  const activeThreadProposals = activeThread
    ? proposals.filter(
        (proposal) =>
          proposal.threadIds.includes(activeThread.id) ||
          activeThread.linkedProposalIds.includes(proposal.id),
      )
    : [];
  const documentAgentThreads = threads.filter(isDocumentLevelThread);
  const documentAgentThreadIds = new Set(documentAgentThreads.map((thread) => thread.id));
  const documentAgentProposals = proposals.filter((proposal) =>
    proposal.threadIds.some((threadId) => documentAgentThreadIds.has(threadId)),
  );

  const setThreadCardOffsetIfChanged = useCallback((nextOffset: number) => {
    setThreadCardOffset((currentOffset) =>
      currentOffset === nextOffset ? currentOffset : nextOffset,
    );
  }, []);

  const setCreateCardOffsetIfChanged = useCallback((nextOffset: number) => {
    setCreateCardOffset((currentOffset) =>
      currentOffset === nextOffset ? currentOffset : nextOffset,
    );
  }, []);

  useEffect(() => {
    loadThreadRef.current = loadThread;
  }, [loadThread]);

  useEffect(() => {
    setDocumentAgentPrompt("");
    setIsDocumentAgentExpanded(false);
  }, [document?.id]);

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!document) {
      return;
    }

    setPendingLinkSelection(null);
    session.replaceContent(document.content);
  }, [document?.content, document?.currentContentHash, document?.id, session]);

  useEffect(() => {
    if (!document || !navigationRequest || navigationRequest.relativePath !== document.relativePath) {
      return;
    }

    session.scrollToLine(navigationRequest.line);
  }, [document, navigationRequest, session]);

  useEffect(() => {
    setFootnoteEditorLabel(activeFootnoteDefinition?.label ?? "");
    setFootnoteEditorContent(activeFootnoteDefinition?.content ?? "");
  }, [activeFootnoteDefinition?.from, activeFootnoteDefinition?.to, activeFootnoteDefinition?.label, activeFootnoteDefinition?.content]);

  useEffect(() => {
    setLinkEditorLabel(activeLink?.label ?? "");
    setLinkEditorUrl(activeLink?.url ?? "");
    setLinkEditorTitle(activeLink?.title ?? "");
  }, [activeLink?.from, activeLink?.to, activeLink?.label, activeLink?.title, activeLink?.url]);

  useEffect(() => {
    if (activeLink) {
      setPendingLinkSelection(null);
    }
  }, [activeLink]);

  const updateLinkEditorFrame = useCallback(() => {
    const range = activeLink
      ? {
          from: activeLink.labelFrom,
          to: activeLink.labelTo,
        }
      : pendingLinkSelection
        ? {
            from: pendingLinkSelection.startOffsetUtf16,
            to: pendingLinkSelection.endOffsetUtf16,
          }
        : null;

    if (!range) {
      setLinkEditorFrame(null);
      return;
    }

    const rect = session.getRangeRect(range.from, range.to);
    if (!rect) {
      setLinkEditorFrame(null);
      return;
    }

    const left = clampDockOffset(
      rect.left + rect.width / 2,
      LINK_POPOVER_MARGIN + LINK_POPOVER_HALF_WIDTH,
      window.innerWidth - LINK_POPOVER_MARGIN - LINK_POPOVER_HALF_WIDTH,
    );
    const placement = rect.top > 128 ? "above" : "below";
    const top = placement === "above" ? rect.top - 10 : rect.bottom + 10;

    setLinkEditorFrame((current) =>
      current &&
      current.left === left &&
      current.top === top &&
      current.placement === placement
        ? current
        : {
            left,
            placement,
            top,
          },
    );
  }, [
    activeLink?.labelFrom,
    activeLink?.labelTo,
    pendingLinkSelection?.startOffsetUtf16,
    pendingLinkSelection?.endOffsetUtf16,
    session,
  ]);

  useLayoutEffect(() => {
    updateLinkEditorFrame();
  }, [updateLinkEditorFrame]);

  useEffect(() => {
    if (!activeLink && !pendingLinkSelection) {
      return;
    }

    window.addEventListener("resize", updateLinkEditorFrame);
    window.addEventListener("scroll", updateLinkEditorFrame, true);
    return () => {
      window.removeEventListener("resize", updateLinkEditorFrame);
      window.removeEventListener("scroll", updateLinkEditorFrame, true);
    };
  }, [activeLink, pendingLinkSelection, updateLinkEditorFrame]);

  const updateDockAlignment = useCallback(() => {
    measurePerf(
      "updateDockAlignment",
      () => {
        const dockBody = dockBodyRef.current;
        if (!dockBody) {
          return;
        }

        const dockRect = dockBody.getBoundingClientRect();
        const topPadding = 12;

        if (selectedThreadId && hostRef.current && activeThreadCardRef.current) {
          const escapedThreadId =
            window.CSS?.escape?.(selectedThreadId) ?? selectedThreadId.replace(/["\\]/g, "\\$&");
          activeMarkerRef.current = hostRef.current.querySelector(
            `[data-thread-role="marker"][data-thread-ids~="${escapedThreadId}"]`,
          ) as HTMLElement | null;

          const markerRect = activeMarkerRef.current?.getBoundingClientRect() ?? null;
          const maxTop = Math.max(
            topPadding,
            dockBody.clientHeight - activeThreadCardRef.current.offsetHeight - topPadding,
          );
          const nextTop = markerRect
            ? clampDockOffset(
                markerRect.top - dockRect.top + dockBody.scrollTop - 8,
                topPadding,
                maxTop,
              )
            : topPadding;
          setThreadCardOffsetIfChanged(nextTop);
        } else {
          activeMarkerRef.current = null;
          setThreadCardOffsetIfChanged(0);
        }

        if (createSelection && createAnchorRectRef.current && createCardRef.current) {
          const maxTop = Math.max(
            topPadding,
            dockBody.clientHeight - createCardRef.current.offsetHeight - topPadding,
          );
          const nextTop = clampDockOffset(
            createAnchorRectRef.current.top - dockRect.top + dockBody.scrollTop - 8,
            topPadding,
            maxTop,
          );
          setCreateCardOffsetIfChanged(nextTop);
        } else {
          setCreateCardOffsetIfChanged(0);
        }
      },
      {
        hasCreateSelection: Boolean(createSelection),
        hasSelectedThread: Boolean(selectedThreadId),
      },
    );
  }, [createSelection, selectedThreadId, setCreateCardOffsetIfChanged, setThreadCardOffsetIfChanged]);

  useLayoutEffect(() => {
    updateDockAlignment();
  }, [updateDockAlignment, activeThread, createSelection]);

  useEffect(() => {
    if (!selectedThreadId && !createSelection) {
      return;
    }

    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        updateDockAlignment();
      });
    };

    const scroller = hostRef.current?.querySelector(".cm-scroller");
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    scroller?.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", scheduleUpdate);
      scroller?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [createSelection, selectedThreadId, updateDockAlignment]);

  useEffect(() => {
    if (!selectedThreadId) {
      setReplyBody("");
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (!activeThread || expandedThreadId !== activeThread.id) {
      setExpandedThreadId(null);
    }
  }, [activeThread?.id, expandedThreadId]);

  useEffect(() => {
    if (!isActiveThreadExpanded) {
      return;
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setExpandedThreadId(null);
    };

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [isActiveThreadExpanded]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedThreadId) {
      setThreadDetail(null);
      setIsThreadDetailLoading(false);
      setThreadDetailError(null);
      return;
    }

    if (!selectedThreadSummary) {
      setThreadDetail(null);
      setIsThreadDetailLoading(false);
      setThreadDetailError(null);
      return;
    }

    if (selectedThreadSummary.messages.length > 0) {
      setThreadDetail(selectedThreadSummary);
      setIsThreadDetailLoading(false);
      setThreadDetailError(null);
      return;
    }

    setThreadDetail(selectedThreadSummary);
    setIsThreadDetailLoading(true);
    setThreadDetailError(null);

    void loadThreadRef.current(selectedThreadId)
      .then((thread) => {
        if (cancelled) {
          return;
        }

        setThreadDetail(thread);
        setThreadDetailError(thread ? null : "Unable to load comments.");
      })
      .catch((error) => {
        if (!cancelled) {
          setThreadDetailError(
            error instanceof Error ? error.message : "Unable to load comments.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsThreadDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedThreadId, selectedThreadSummary]);

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    let cancelled = false;

    const refreshSelectedThreadDetail = () => {
      if (cancelled || window.document.visibilityState !== "visible") {
        return;
      }

      void loadThreadRef.current(selectedThreadId)
        .then((thread) => {
          if (cancelled || !thread || thread.id !== selectedThreadId) {
            return;
          }

          setThreadDetail(thread);
          setThreadDetailError(null);
        })
        .catch((error) => {
          if (!cancelled) {
            setThreadDetailError(
              error instanceof Error ? error.message : "Unable to load comments.",
            );
          }
        });
    };

    const handleVisibilityChange = () => {
      if (window.document.visibilityState !== "visible") {
        return;
      }

      refreshSelectedThreadDetail();
    };

    window.addEventListener("focus", refreshSelectedThreadDetail);
    window.document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshSelectedThreadDetail);
      window.document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [selectedThreadId]);

  useEffect(() => {
    if (selectedThreadId) {
      setCreateSelection(null);
      createAnchorRectRef.current = null;
      setNewCommentBody("");
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (createSelection) {
      setReplyBody("");
    }
  }, [createSelection]);

  useEffect(() => {
    if (selectedThreadId && !selectedThreadSummary) {
      onThreadSelect(null);
    }
  }, [onThreadSelect, selectedThreadSummary, selectedThreadId]);

  const handleSave = useCallback(() => {
    onSave(session.getContent());
  }, [onSave, session]);

  const handleFind = useCallback(() => {
    session.openSearch();
  }, [session]);

  const getCommentDockWidthBounds = useCallback(() => {
    const viewportMax =
      typeof window === "undefined"
        ? COMMENT_DOCK_MAX_WIDTH
        : Math.max(COMMENT_DOCK_MIN_WIDTH, window.innerWidth - 560);

    return {
      max: Math.min(COMMENT_DOCK_MAX_WIDTH, viewportMax),
      min: COMMENT_DOCK_MIN_WIDTH,
    };
  }, []);

  const setBoundedCommentDockWidth = useCallback(
    (nextWidth: number) => {
      const bounds = getCommentDockWidthBounds();
      setCommentDockWidth(clampDockOffset(Math.round(nextWidth), bounds.min, bounds.max));
    },
    [getCommentDockWidthBounds, setCommentDockWidth],
  );

  const handleCommentDockResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = commentDockWidth;
      const bodyCursor = window.document.body.style.cursor;
      const bodyUserSelect = window.document.body.style.userSelect;
      setIsResizingCommentDock(true);
      window.document.body.style.cursor = "col-resize";
      window.document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = startWidth + startX - moveEvent.clientX;
        setBoundedCommentDockWidth(nextWidth);
      };

      const handlePointerUp = () => {
        setIsResizingCommentDock(false);
        window.document.body.style.cursor = bodyCursor;
        window.document.body.style.userSelect = bodyUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [commentDockWidth, setBoundedCommentDockWidth],
  );

  const handleCommentDockResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 48 : 24;
      const bounds = getCommentDockWidthBounds();
      let nextWidth: number | null = null;

      switch (event.key) {
        case "ArrowLeft":
          nextWidth = commentDockWidth + step;
          break;
        case "ArrowRight":
          nextWidth = commentDockWidth - step;
          break;
        case "Home":
          nextWidth = bounds.min;
          break;
        case "End":
          nextWidth = bounds.max;
          break;
        default:
          break;
      }

      if (nextWidth === null) {
        return;
      }

      event.preventDefault();
      setBoundedCommentDockWidth(nextWidth);
    },
    [commentDockWidth, getCommentDockWidthBounds, setBoundedCommentDockWidth],
  );

  useEffect(() => {
    if (!document) {
      return;
    }

    const saveDirtyDocument = () => {
      if (isSaving || !session.isDirty()) {
        return;
      }

      onSave(session.getContent());
    };

    const handleKeydown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "s";
      const isFindShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f";

      if (!isSaveShortcut && !isFindShortcut) {
        return;
      }

      event.preventDefault();
      if (isFindShortcut) {
        session.openSearch();
        return;
      }

      saveDirtyDocument();
    };

    const handleMenuCommand = (event: Event) => {
      const command = (event as CustomEvent<unknown>).detail;
      if (!isAppMenuCommand(command)) {
        return;
      }

      if (command === APP_MENU_COMMANDS.find) {
        session.openSearch();
        return;
      }

      if (command === APP_MENU_COMMANDS.save) {
        saveDirtyDocument();
      }
    };

    window.addEventListener("keydown", handleKeydown);
    window.addEventListener(APP_MENU_DOM_EVENT, handleMenuCommand);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener(APP_MENU_DOM_EVENT, handleMenuCommand);
    };
  }, [document, isSaving, onSave, session]);

  useEffect(() => {
    if (!document || !isDirty || isSaving) {
      return;
    }

    const autosaveTimeoutId = window.setTimeout(() => {
      if (!session.isDirty()) {
        return;
      }

      onSave(session.getContent());
    }, AUTOSAVE_IDLE_DELAY_MS);

    return () => {
      window.clearTimeout(autosaveTimeoutId);
    };
  }, [document?.id, isDirty, isSaving, onSave, session, sessionSnapshot.revision]);

  const commentDockWidthBounds = getCommentDockWidthBounds();
  const editorWorkbenchStyle = {
    "--comment-dock-width": `${commentDockWidth}px`,
  } as CSSProperties;

  const handleReply = useCallback(async () => {
    if (!activeThread || !replyBody.trim()) {
      return;
    }

    await addReply(activeThread.id, replyBody);
    setReplyBody("");
  }, [activeThread, addReply, replyBody]);

  const handleProviderThreadAction = useCallback(
    async (provider: AgentProviderId, action: ProviderThreadActionKind) => {
      if (!activeThread) {
        return;
      }

      const instruction = replyBody.trim();
      if (!instruction && activeThread.messages.length === 0) {
        return;
      }

      try {
        if (instruction) {
          await addReply(activeThread.id, instruction);
          setReplyBody("");
        }
        await onRunProviderThreadAction(
          provider,
          action,
          activeThread.id,
          instruction,
          selectedReviewPassName,
        );
      } catch {
        // The parent surfaces the actionable error in the dock.
      }
    },
    [activeThread, addReply, onRunProviderThreadAction, replyBody, selectedReviewPassName],
  );

  const handleDocumentComment = useCallback(async () => {
    const body = documentAgentPrompt.trim();
    if (!body) {
      return;
    }

    await createDocumentThread(body);
    setDocumentAgentPrompt("");
  }, [createDocumentThread, documentAgentPrompt]);

  const handleProviderDocumentAction = useCallback(
    async (provider: AgentProviderId, action: ProviderDocumentActionKind) => {
      try {
        await onRunProviderDocumentAction(
          provider,
          action,
          documentAgentPrompt,
          selectedReviewPassName,
        );
        setDocumentAgentPrompt("");
        setIsDocumentAgentExpanded(false);
      } catch {
        setIsDocumentAgentExpanded(true);
      }
    },
    [documentAgentPrompt, onRunProviderDocumentAction, selectedReviewPassName],
  );

  const handleCreateThread = useCallback(async () => {
    if (!createSelection || !newCommentBody.trim()) {
      return;
    }

    await createThreadFromSelection(newCommentBody, createSelection, session.getContent());
    createAnchorRectRef.current = null;
    setCreateSelection(null);
    setNewCommentBody("");
  }, [createSelection, createThreadFromSelection, newCommentBody, session]);

  const handleClearCreate = useCallback(() => {
    createAnchorRectRef.current = null;
    setCreateSelection(null);
    setNewCommentBody("");
  }, []);

  const handleExpandActiveThread = useCallback(() => {
    if (!activeThread) {
      return;
    }

    setExpandedThreadId(activeThread.id);
  }, [activeThread]);

  const handleCollapseExpandedThread = useCallback(() => {
    setExpandedThreadId(null);
  }, []);

  const handleApplyLinkEdit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (!activeLink && !pendingLinkSelection) {
        return;
      }

      if (!linkEditorLabel.trim() || !linkEditorUrl.trim()) {
        return;
      }

      const nextValues = {
        label: linkEditorLabel,
        title: linkEditorTitle.trim() ? linkEditorTitle : null,
        url: linkEditorUrl,
      };

      if (activeLink) {
        session.updateMarkdownLink(activeLink, nextValues);
      } else if (pendingLinkSelection) {
        session.createMarkdownLink(pendingLinkSelection, nextValues);
        setPendingLinkSelection(null);
      }

      session.focus();
    },
    [activeLink, linkEditorLabel, linkEditorTitle, linkEditorUrl, pendingLinkSelection, session],
  );

  const handleApplyFootnoteEdit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (!activeFootnoteDefinition) {
        return;
      }

      session.updateFootnoteDefinition(activeFootnoteDefinition, {
        content: footnoteEditorContent,
        label: footnoteEditorLabel,
      });
      session.focus();
    },
    [activeFootnoteDefinition, footnoteEditorContent, footnoteEditorLabel, session],
  );

  const handleFocusFootnoteDefinition = useCallback(() => {
    if (!activeFootnoteDefinition) {
      return;
    }

    session.focusFootnoteDefinition(activeFootnoteDefinition);
  }, [activeFootnoteDefinition, session]);

  const handleRemoveLink = useCallback(() => {
    if (!activeLink) {
      return;
    }

    session.removeMarkdownLink(activeLink);
    session.focus();
  }, [activeLink, session]);

  const handleCancelLinkCreate = useCallback(() => {
    setPendingLinkSelection(null);
    setLinkEditorLabel("");
    setLinkEditorUrl("");
    setLinkEditorTitle("");
    session.focus();
  }, [session]);

  if (!document) {
    return (
      <div className="editor-placeholder">
        <div className="empty-state-card">
          <p className="eyebrow">Editor</p>
          <h2>Select a document to load it into the center pane.</h2>
          <p>
            Margent uses a single source-first editor. Select text to add comments, or click
            thread markers to view existing discussion inline.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section
      className={`editor-shell ${editorMode === "rendered" ? "is-rendered-shell" : "is-raw-shell"} ${
        isFocusModeEnabled ? "is-focus-mode-shell" : ""
      }`}
    >
      <EditorHeader
        characterCount={characterCount}
        document={document}
        editorMode={editorMode}
        isFocusModeEnabled={isFocusModeEnabled}
        isDirty={isDirty}
        isSaving={isSaving}
        lineCount={lineCount}
        onEditorModeChange={setEditorMode}
        onFind={handleFind}
        onFocusModeToggle={toggleFocusMode}
        onSave={handleSave}
        threadCount={threads.filter((thread) => thread.status === "open").length}
      />

      <div
        className={`editor-workbench ${isResizingCommentDock ? "is-resizing-comment-dock" : ""} ${
          isActiveThreadExpanded ? "has-expanded-thread" : ""
        }`}
        style={editorWorkbenchStyle}
      >
        {isActiveThreadExpanded ? (
          <button
            aria-label="Retract expanded comment thread"
            className="thread-expanded-backdrop"
            onClick={handleCollapseExpandedThread}
            type="button"
          />
        ) : null}
        <EditorSurface
          activeFootnoteDefinition={activeFootnoteDefinition}
          activeLink={activeLink}
          editorMode={editorMode}
          footnoteEditorContent={footnoteEditorContent}
          footnoteEditorLabel={footnoteEditorLabel}
          onApplyFootnoteEdit={handleApplyFootnoteEdit}
          linkEditorLabel={linkEditorLabel}
          linkEditorUrl={linkEditorUrl}
          linkEditorFrame={linkEditorFrame}
          isCreatingLink={pendingLinkSelection !== null && !activeLink}
          onCancelLinkCreate={handleCancelLinkCreate}
          onFootnoteEditorContentChange={setFootnoteEditorContent}
          onFootnoteEditorLabelChange={setFootnoteEditorLabel}
          onFocusFootnoteDefinition={handleFocusFootnoteDefinition}
          onApplyLinkEdit={handleApplyLinkEdit}
          onLinkEditorUrlChange={setLinkEditorUrl}
          onRemoveLink={handleRemoveLink}
          setEditorHost={setEditorHost}
        />
        <button
          aria-label="Resize comments pane"
          aria-orientation="vertical"
          aria-valuemax={commentDockWidthBounds.max}
          aria-valuemin={commentDockWidthBounds.min}
          aria-valuenow={commentDockWidth}
          className="comment-dock-resizer"
          onKeyDown={handleCommentDockResizeKeyDown}
          onPointerDown={handleCommentDockResizePointerDown}
          role="separator"
          title="Drag to resize comments"
          type="button"
        >
          <span aria-hidden="true" className="comment-dock-resizer-handle" />
        </button>
        <CommentDock
          activeThread={activeThread}
          activeThreadCardRef={activeThreadCardRef}
          activeThreadProposals={activeThreadProposals}
          createCardOffset={createCardOffset}
          createCardRef={createCardRef}
          createSelection={createSelection}
          deleteThread={deleteThread}
          documentAgentPrompt={documentAgentPrompt}
          documentAgentProposals={documentAgentProposals}
          documentAgentThreads={documentAgentThreads}
          documentContentHash={document.currentContentHash}
          documentId={document.id}
          dockBodyRef={dockBodyRef}
          isDocumentAgentExpanded={isDocumentAgentExpanded}
          isDocumentOutlineVisible={isDocumentOutlineVisible}
          isDirty={isDirty}
          isThreadExpanded={isActiveThreadExpanded}
          onAcceptProposal={onAcceptProposal}
          isThreadDetailLoading={isThreadDetailLoading}
          isThreadSaving={isThreadSaving}
          newCommentBody={newCommentBody}
          onCancelProviderRun={onCancelProviderRun}
          onClearCreate={handleClearCreate}
          onCreateThread={handleCreateThread}
          onDocumentComment={handleDocumentComment}
          onDocumentAgentPromptChange={setDocumentAgentPrompt}
          onDocumentAgentToggle={() => setIsDocumentAgentExpanded((current) => !current)}
          onNewCommentBodyChange={setNewCommentBody}
          onOutlineHeadingSelect={session.scrollToLine}
          onOutlineToggle={toggleDocumentOutline}
          onThreadCollapse={handleCollapseExpandedThread}
          onThreadExpand={handleExpandActiveThread}
          onProviderDocumentAction={handleProviderDocumentAction}
          onProviderThreadAction={handleProviderThreadAction}
          onRejectProposal={onRejectProposal}
          onReply={handleReply}
          onReplyBodyChange={setReplyBody}
          onThreadSelect={onThreadSelect}
          preferredAgentProvider={preferredAgentProvider}
          providerActionState={providerActionState}
          providerDocumentActionState={providerDocumentActionState}
          outlineHeadings={document.headingIndex}
          proposalActionKind={proposalActionKind}
          proposalActionProposalId={proposalActionProposalId}
          proposalErrorMessage={proposalErrorMessage}
          reopenThread={reopenThread}
          replyBody={replyBody}
          reviewPasses={reviewPasses}
          resolveThread={resolveThread}
          selectedReviewPassName={selectedReviewPassName}
          setPreferredAgentProvider={setPreferredAgentProvider}
          setSelectedReviewPassName={setSelectedReviewPassName}
          threadCardOffset={threadCardOffset}
          threadDetailError={threadDetailError}
        />
      </div>
    </section>
  );
});

const EditorHeader = memo(function EditorHeader({
  characterCount,
  document,
  editorMode,
  isFocusModeEnabled,
  isDirty,
  isSaving,
  lineCount,
  onEditorModeChange,
  onFind,
  onFocusModeToggle,
  onSave,
  threadCount,
}: {
  characterCount: number;
  document: DocumentPayload;
  editorMode: EditorMode;
  isFocusModeEnabled: boolean;
  isDirty: boolean;
  isSaving: boolean;
  lineCount: number;
  onEditorModeChange: (editorMode: EditorMode) => void;
  onFind: () => void;
  onFocusModeToggle: () => void;
  onSave: () => void;
  threadCount: number;
}) {
  const openThreadCount = threadCount;
  const statusLabel = isSaving ? "Saving" : isDirty ? "Unsaved changes" : "Saved";
  const shouldShowPath = document.relativePath !== document.displayName;

  return (
    <header className="editor-header">
      <div className="editor-title-group">
        <h2 className="doc-title">{document.displayName}</h2>
        {shouldShowPath ? <p className="doc-path">{document.relativePath}</p> : null}
        <div className="stats-row" aria-label={statusLabel}>
          <span
            aria-hidden="true"
            className={`save-state-dot ${
              isSaving ? "is-saving" : isDirty ? "is-dirty" : "is-clean"
            }`}
            title={statusLabel}
          />
          <details className="stats-detail">
            <summary>
              <span>{document.wordCount} words</span>
              {openThreadCount ? (
                <span>
                  {openThreadCount} open thread{openThreadCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </summary>
            <div className="stats-popover">
              <span>{lineCount} lines</span>
              <span>{characterCount} chars</span>
              <span>{document.lastKnownLineEnding.toUpperCase()}</span>
            </div>
          </details>
        </div>
      </div>

      <div className="editor-toolbar doc-actions">
        <div aria-label="Editor mode" className="seg" role="tablist">
          <button
            aria-selected={editorMode === "rendered"}
            className={editorMode === "rendered" ? "on" : undefined}
            onClick={() => onEditorModeChange("rendered")}
            role="tab"
            type="button"
          >
            Rendered
          </button>
          <button
            aria-selected={editorMode === "raw"}
            className={editorMode === "raw" ? "on" : undefined}
            onClick={() => onEditorModeChange("raw")}
            role="tab"
            type="button"
          >
            Raw
          </button>
        </div>
        <button className="ghost-button editor-find-button" onClick={onFind} type="button">
          Find
        </button>
        <button
          aria-pressed={isFocusModeEnabled}
          className={`ghost-button editor-focus-button ${isFocusModeEnabled ? "on" : ""}`}
          onClick={onFocusModeToggle}
          type="button"
        >
          Focus
        </button>
        <button
          className={`primary-button save-button ${isDirty ? "is-dirty" : "is-clean"}`}
          disabled={isSaving || !isDirty}
          onClick={onSave}
        >
          {isSaving ? "Saving..." : "Save Draft"}
        </button>
      </div>
    </header>
  );
});

const EditorSurface = memo(function EditorSurface({
  activeFootnoteDefinition,
  activeLink,
  editorMode,
  footnoteEditorContent,
  footnoteEditorLabel,
  isCreatingLink,
  onApplyFootnoteEdit,
  onCancelLinkCreate,
  onFootnoteEditorContentChange,
  onFootnoteEditorLabelChange,
  onFocusFootnoteDefinition,
  linkEditorLabel,
  linkEditorFrame,
  linkEditorUrl,
  onApplyLinkEdit,
  onLinkEditorUrlChange,
  onRemoveLink,
  setEditorHost,
}: {
  activeFootnoteDefinition: ActiveFootnoteDefinition | null;
  activeLink: ActiveMarkdownLink | null;
  editorMode: EditorMode;
  footnoteEditorContent: string;
  footnoteEditorLabel: string;
  isCreatingLink: boolean;
  onApplyFootnoteEdit: (event?: FormEvent) => void;
  onCancelLinkCreate: () => void;
  onFootnoteEditorContentChange: Dispatch<SetStateAction<string>>;
  onFootnoteEditorLabelChange: Dispatch<SetStateAction<string>>;
  onFocusFootnoteDefinition: () => void;
  linkEditorLabel: string;
  linkEditorFrame: LinkEditorFrame | null;
  linkEditorUrl: string;
  onApplyLinkEdit: (event?: FormEvent) => void;
  onLinkEditorUrlChange: Dispatch<SetStateAction<string>>;
  onRemoveLink: () => void;
  setEditorHost: (node: HTMLDivElement | null) => void;
}) {
  const shouldShowLinkPopover = isCreatingLink || (editorMode === "rendered" && activeLink);
  const linkPopoverStyle: CSSProperties | undefined = linkEditorFrame
    ? {
        left: `${linkEditorFrame.left}px`,
        top: `${linkEditorFrame.top}px`,
      }
    : undefined;

  return (
    <div className={`editor-main ${editorMode === "rendered" ? "is-rendered-mode" : "is-raw-mode"}`}>
      <div className="editor-surface">
        {shouldShowLinkPopover ? (
          <form
            className={`link-editor-popover is-${linkEditorFrame?.placement ?? "above"}`}
            onSubmit={onApplyLinkEdit}
            style={linkPopoverStyle}
          >
            <label className="link-popover-url-field">
              <span>Link</span>
              <input
                aria-label="Link URL"
                autoFocus={isCreatingLink}
                onChange={(event) => onLinkEditorUrlChange(event.target.value)}
                placeholder="Paste or type URL"
                type="text"
                value={linkEditorUrl}
              />
            </label>
            <button
              className="primary-button link-popover-apply"
              disabled={!linkEditorLabel.trim() || !linkEditorUrl.trim()}
              type="submit"
            >
              {isCreatingLink ? "Create" : "Apply"}
            </button>
            {isCreatingLink ? (
              <button className="ghost-button link-popover-button" onClick={onCancelLinkCreate} type="button">
                Cancel
              </button>
            ) : (
              <button className="ghost-button link-popover-button" onClick={onRemoveLink} type="button">
                Remove
              </button>
            )}
          </form>
        ) : editorMode === "rendered" && activeFootnoteDefinition ? (
          <form className="footnote-editor-bar" onSubmit={onApplyFootnoteEdit}>
            <div className="footnote-editor-title-group">
              <p className="eyebrow-lbl">Editing footnote</p>
              <p className="footnote-editor-caption">
                Update the label or definition without leaving rendered mode.
              </p>
            </div>
            <label className="link-editor-field footnote-editor-field-label">
              <span>Label</span>
              <input
                onChange={(event) => onFootnoteEditorLabelChange(event.target.value)}
                type="text"
                value={footnoteEditorLabel}
              />
            </label>
            <label className="link-editor-field footnote-editor-field-content">
              <span>Definition</span>
              <textarea
                onChange={(event) => onFootnoteEditorContentChange(event.target.value)}
                rows={4}
                value={footnoteEditorContent}
              />
            </label>
            <div className="footnote-editor-actions">
              <button className="ghost-button" onClick={onFocusFootnoteDefinition} type="button">
                Reveal Block
              </button>
              <button
                className="primary-button"
                disabled={!footnoteEditorLabel.trim()}
                type="submit"
              >
                Apply Footnote
              </button>
            </div>
          </form>
        ) : null}
        <div className="code-editor-host" ref={setEditorHost} />
      </div>
    </div>
  );
});

const CommentDock = memo(function CommentDock({
  activeThread,
  activeThreadCardRef,
  activeThreadProposals,
  createCardOffset,
  createCardRef,
  createSelection,
  deleteThread,
  documentAgentPrompt,
  documentAgentProposals,
  documentAgentThreads,
  documentContentHash,
  documentId,
  dockBodyRef,
  isDocumentAgentExpanded,
  isDocumentOutlineVisible,
  isDirty,
  isThreadDetailLoading,
  isThreadExpanded,
  isThreadSaving,
  newCommentBody,
  onAcceptProposal,
  onCancelProviderRun,
  onClearCreate,
  onCreateThread,
  onDocumentComment,
  onDocumentAgentPromptChange,
  onDocumentAgentToggle,
  onNewCommentBodyChange,
  onOutlineHeadingSelect,
  onOutlineToggle,
  onProviderDocumentAction,
  onProviderThreadAction,
  onRejectProposal,
  onReply,
  onReplyBodyChange,
  onThreadCollapse,
  onThreadExpand,
  onThreadSelect,
  preferredAgentProvider,
  providerActionState,
  providerDocumentActionState,
  outlineHeadings,
  proposalActionKind,
  proposalActionProposalId,
  proposalErrorMessage,
  reopenThread,
  replyBody,
  reviewPasses,
  resolveThread,
  selectedReviewPassName,
  setPreferredAgentProvider,
  setSelectedReviewPassName,
  threadCardOffset,
  threadDetailError,
}: {
  activeThread: ThreadRecord | null;
  activeThreadCardRef: RefObject<HTMLElement | null>;
  activeThreadProposals: ProposalRecord[];
  createCardOffset: number;
  createCardRef: RefObject<HTMLElement | null>;
  createSelection: EditorSelectionSnapshot | null;
  deleteThread: (threadId: string) => Promise<void>;
  documentAgentPrompt: string;
  documentAgentProposals: ProposalRecord[];
  documentAgentThreads: ThreadRecord[];
  documentContentHash: string;
  documentId: string;
  dockBodyRef: RefObject<HTMLDivElement | null>;
  isDocumentAgentExpanded: boolean;
  isDocumentOutlineVisible: boolean;
  isDirty: boolean;
  isThreadDetailLoading: boolean;
  isThreadExpanded: boolean;
  isThreadSaving: boolean;
  newCommentBody: string;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onCancelProviderRun: (runId: string | null) => Promise<void>;
  onClearCreate: () => void;
  onCreateThread: () => void | Promise<void>;
  onDocumentComment: () => void | Promise<void>;
  onDocumentAgentPromptChange: Dispatch<SetStateAction<string>>;
  onDocumentAgentToggle: () => void;
  onNewCommentBodyChange: Dispatch<SetStateAction<string>>;
  onOutlineHeadingSelect: (lineNumber: number) => void;
  onOutlineToggle: () => void;
  onProviderDocumentAction: (
    provider: AgentProviderId,
    action: ProviderDocumentActionKind,
  ) => void | Promise<void>;
  onProviderThreadAction: (
    provider: AgentProviderId,
    action: ProviderThreadActionKind,
  ) => void | Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
  onReply: () => void | Promise<void>;
  onReplyBodyChange: Dispatch<SetStateAction<string>>;
  onThreadCollapse: () => void;
  onThreadExpand: () => void;
  onThreadSelect: (threadId: string | null) => void;
  preferredAgentProvider: AgentProviderId;
  providerActionState: ProviderActionState;
  providerDocumentActionState: ProviderDocumentActionState;
  outlineHeadings: HeadingIndexEntry[];
  proposalActionKind: "accept" | "reject" | null;
  proposalActionProposalId: string | null;
  proposalErrorMessage: string | null;
  reopenThread: (threadId: string) => Promise<void>;
  replyBody: string;
  reviewPasses: ReviewPassSummary[];
  resolveThread: (threadId: string) => Promise<void>;
  selectedReviewPassName: string | null;
  setPreferredAgentProvider: (provider: AgentProviderId) => void;
  setSelectedReviewPassName: (passName: string | null) => void;
  threadCardOffset: number;
  threadDetailError: string | null;
}) {
  const activeProviderAction =
    activeThread && providerActionState.threadId === activeThread.id
      ? providerActionState.action
      : null;
  const activeProvider =
    activeThread && providerActionState.threadId === activeThread.id
      ? providerActionState.provider
      : null;
  const providerError =
    activeThread && providerActionState.threadId === activeThread.id
      ? providerActionState.errorMessage
      : null;
  const activeProviderRunId =
    activeThread && providerActionState.threadId === activeThread.id
      ? providerActionState.runId
      : null;
  const activeProviderStreamedText =
    activeThread && providerActionState.threadId === activeThread.id
      ? providerActionState.streamedText
      : "";
  const isProviderRunning = activeProviderAction !== null;
  const isActiveDocumentThread = activeThread ? isDocumentLevelThread(activeThread) : false;
  const isActiveThreadOlderVersion =
    activeThread !== null &&
    (activeThread.lastReanchorContentHash ?? activeThread.anchor.baseContentHash) !==
      documentContentHash;
  const activeDocumentProviderAction =
    providerDocumentActionState.documentId === documentId ? providerDocumentActionState.action : null;
  const activeDocumentProvider =
    providerDocumentActionState.documentId === documentId ? providerDocumentActionState.provider : null;
  const documentProviderError =
    providerDocumentActionState.documentId === documentId
      ? providerDocumentActionState.errorMessage
      : null;
  const activeDocumentProviderRunId =
    providerDocumentActionState.documentId === documentId
      ? providerDocumentActionState.runId
      : null;
  const activeDocumentProviderStreamedText =
    providerDocumentActionState.documentId === documentId
      ? providerDocumentActionState.streamedText
      : "";
  const isDocumentProviderRunning = activeDocumentProviderAction !== null;
  const selectedProvider = activeProvider ?? preferredAgentProvider;
  const hasThreadComposerText = Boolean(replyBody.trim());
  const showThreadComposerActions =
    Boolean(activeThread && activeThread.messages.length > 0) || hasThreadComposerText;
  const canRunThreadAgent =
    showThreadComposerActions && !isProviderRunning && !isThreadSaving && !isDirty;
  const handleDeleteActiveThread = useCallback(async () => {
    if (!activeThread) {
      return;
    }

    const confirmed = await confirmThreadDelete();
    if (confirmed) {
      await deleteThread(activeThread.id);
    }
  }, [activeThread, deleteThread]);
  const handleActiveThreadCardClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (isThreadExpanded || isInteractiveCommentTarget(event.target)) {
        return;
      }

      onThreadExpand();
    },
    [isThreadExpanded, onThreadExpand],
  );

  return (
    <aside className="comment-dock">
      <DocumentAgentPanel
        activeActionKind={proposalActionKind}
        activeActionProposalId={proposalActionProposalId}
        activeProvider={activeDocumentProvider}
        activeProviderAction={activeDocumentProviderAction}
        activeProviderRunId={activeDocumentProviderRunId}
        activeProviderStreamedText={activeDocumentProviderStreamedText}
        errorMessage={documentProviderError}
        isDirty={isDirty}
        isExpanded={isDocumentAgentExpanded}
        isProviderRunning={isDocumentProviderRunning}
        isThreadSaving={isThreadSaving}
        onAcceptProposal={onAcceptProposal}
        onCancelProviderRun={onCancelProviderRun}
        onComment={onDocumentComment}
        onPromptChange={onDocumentAgentPromptChange}
        onProviderAction={onProviderDocumentAction}
        onRejectProposal={onRejectProposal}
        onThreadSelect={onThreadSelect}
        onToggle={onDocumentAgentToggle}
        prompt={documentAgentPrompt}
        preferredAgentProvider={preferredAgentProvider}
        proposalActionErrorMessage={proposalErrorMessage}
        proposals={documentAgentProposals}
        reviewPasses={reviewPasses}
        selectedReviewPassName={selectedReviewPassName}
        selectedThreadId={activeThread?.id ?? null}
        setPreferredAgentProvider={setPreferredAgentProvider}
        setSelectedReviewPassName={setSelectedReviewPassName}
        threads={documentAgentThreads}
      />
      <div className="document-outline-toggle-row">
        <button
          aria-expanded={isDocumentOutlineVisible}
          className="ghost-button document-outline-toggle"
          onClick={onOutlineToggle}
          type="button"
        >
          {isDocumentOutlineVisible ? "Hide Outline" : "Show Outline"}
        </button>
      </div>
      {isDocumentOutlineVisible ? (
        <DocumentOutlinePanel headings={outlineHeadings} onHeadingSelect={onOutlineHeadingSelect} />
      ) : null}
      <div className="comment-dock-body" ref={dockBodyRef}>
        {activeThread ? (
          <section
            className={`thread-section thread-detail-section comment-dock-section comment-dock-card ${
              isThreadExpanded ? "is-expanded-thread-card" : "can-expand-thread-card"
            }`}
            onClick={handleActiveThreadCardClick}
            ref={activeThreadCardRef}
            style={isThreadExpanded ? undefined : { marginTop: `${threadCardOffset}px` }}
          >
            <div className="thread-card-toolbar">
              <span className="thread-card-toolbar-meta">
                {activeThread.messages.length} message{activeThread.messages.length === 1 ? "" : "s"}
              </span>
              <div className="thread-card-toolbar-actions">
                {activeThread.status === "open" ? (
                  <button
                    className="ghost-button"
                    disabled={isThreadSaving}
                    onClick={() => void resolveThread(activeThread.id)}
                    type="button"
                  >
                    Resolve
                  </button>
                ) : (
                  <button
                    className="ghost-button"
                    disabled={isThreadSaving}
                    onClick={() => void reopenThread(activeThread.id)}
                    type="button"
                  >
                    Reopen
                  </button>
                )}
                <button className="ghost-button" onClick={() => onThreadSelect(null)} type="button">
                  Close
                </button>
                <button
                  className="ghost-button danger-button"
                  disabled={isThreadSaving}
                  onClick={() => void handleDeleteActiveThread()}
                  type="button"
                >
                  Delete
                </button>
                <button
                  className="ghost-button thread-card-expand-button"
                  onClick={isThreadExpanded ? onThreadCollapse : onThreadExpand}
                  type="button"
                >
                  {isThreadExpanded ? "Retract" : "Expand"}
                </button>
              </div>
            </div>
            {isActiveThreadOlderVersion ? (
              <p className="thread-version-warning">Applies to an older document version.</p>
            ) : null}
            <div className="thread-detail comment-dock-detail">
              <div className="thread-messages comment-dock-messages">
                {activeThread.messages.length > 0 ? (
                  activeThread.messages.map((message) => (
                    <div className={getThreadMessageClassName(message)} key={message.id}>
                      <div className="thread-message-meta">
                        <strong className="thread-message-author">
                          {formatMessageAuthor(message)}
                        </strong>
                        <span className="thread-message-timestamp">
                          {timestampFormatter.format(new Date(message.createdAt))}
                        </span>
                      </div>
                      <p className="thread-message-body">
                        {renderThreadMessageBody(message.body)}
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="inline-thread-status">
                    {isThreadDetailLoading
                      ? "Loading comments..."
                      : threadDetailError ?? "No comments found in this thread."}
                  </div>
                )}
              </div>

              <textarea
                className="thread-textarea comment-dock-textarea"
                onChange={(event) => onReplyBodyChange(event.currentTarget.value)}
                placeholder="Comment..."
                rows={4}
                value={replyBody}
              />

              {showThreadComposerActions ? (
                <div className="thread-composer-actions">
                  <button
                    className="primary-button"
                    disabled={!hasThreadComposerText || isThreadSaving}
                    onClick={() => void onReply()}
                    type="button"
                  >
                    Comment
                  </button>
                  <ProviderToggle
                    disabled={isProviderRunning}
                    onChange={setPreferredAgentProvider}
                    provider={selectedProvider}
                  />
                  <ReviewPassSelect
                    disabled={isProviderRunning}
                    onChange={setSelectedReviewPassName}
                    reviewPasses={reviewPasses}
                    selectedPassName={selectedReviewPassName}
                  />
                  <button
                    className="ghost-button"
                    disabled={!canRunThreadAgent}
                    onClick={() => void onProviderThreadAction(selectedProvider, "feedback")}
                    type="button"
                  >
                    {activeProviderAction === "feedback" && activeProvider
                      ? `Asking ${formatProviderDisplayName(activeProvider)}...`
                      : "Ask"}
                  </button>
                  <button
                    className="ghost-button"
                    disabled={!canRunThreadAgent}
                    onClick={() => void onProviderThreadAction(selectedProvider, "revise")}
                    type="button"
                  >
                    {activeProviderAction === "revise" && activeProvider
                      ? isActiveDocumentThread
                        ? `Revising document with ${formatProviderDisplayName(activeProvider)}...`
                        : `Revising with ${formatProviderDisplayName(activeProvider)}...`
                      : isActiveDocumentThread
                        ? "Revise Document"
                        : "Revise"}
                  </button>
                </div>
              ) : null}
              {isProviderRunning || isDirty || providerError ? (
                <div className="agent-action-box unified-agent-status">
                  {isProviderRunning && activeProvider ? (
                    <AgentRunningCard
                      action={activeProviderAction}
                      onStop={onCancelProviderRun}
                      provider={activeProvider}
                      runId={activeProviderRunId}
                      scope={isActiveDocumentThread ? "document" : "thread"}
                      streamedText={activeProviderStreamedText}
                    />
                  ) : null}
                  {isDirty ? (
                    <p className="inline-thread-status agent-action-note">
                      Save to enable agent actions.
                    </p>
                  ) : null}
                  {providerError ? (
                    <p className="inline-thread-status agent-action-error">{providerError}</p>
                  ) : null}
                </div>
              ) : null}

              <ThreadProposalList
                activeActionKind={proposalActionKind}
                activeActionProposalId={proposalActionProposalId}
                errorMessage={proposalErrorMessage}
                onAcceptProposal={onAcceptProposal}
                onRejectProposal={onRejectProposal}
                proposals={activeThreadProposals}
                showFullAssistantMessages={isThreadExpanded}
              />
            </div>
          </section>
        ) : createSelection ? (
          <section
            className="thread-section comment-dock-section comment-dock-card"
            ref={createCardRef}
            style={{ marginTop: `${createCardOffset}px` }}
          >
            <div className="selection-card comment-dock-detail">
              <textarea
                className="thread-textarea comment-dock-textarea"
                onChange={(event) => onNewCommentBodyChange(event.currentTarget.value)}
                placeholder="Leave a comment..."
                rows={5}
                value={newCommentBody}
              />
              <div className="thread-actions">
                <button
                  className="primary-button"
                  disabled={!newCommentBody.trim() || isThreadSaving}
                  onClick={() => void onCreateThread()}
                >
                  {isThreadSaving ? "Creating..." : "Comment"}
                </button>
                <button className="ghost-button" onClick={onClearCreate}>
                  Clear
                </button>
              </div>
            </div>
          </section>
        ) : (
      <div className="thread-card comment-dock-empty">
        <div className="thread-card-inner comments-empty">
          <div className="label">Comments</div>
          <h2>Nothing selected.</h2>
              <p>
                Click a numbered marker in the editor rail to inspect a thread here, or select
                text in the document to start a new comment without covering the page.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
});

const DocumentOutlinePanel = memo(function DocumentOutlinePanel({
  headings,
  onHeadingSelect,
}: {
  headings: HeadingIndexEntry[];
  onHeadingSelect: (lineNumber: number) => void;
}) {
  const visibleHeadings = headings.filter((heading) => heading.text.trim());

  return (
    <section className="document-outline-panel">
      <div className="document-outline-header">
        <span className="document-outline-title">Outline</span>
        <span className="document-outline-meta">
          {visibleHeadings.length
            ? `${visibleHeadings.length} heading${visibleHeadings.length === 1 ? "" : "s"}`
            : "No headings"}
        </span>
      </div>
      {visibleHeadings.length ? (
        <div className="document-outline-list">
          {visibleHeadings.map((heading, index) => (
            <button
              className="document-outline-button"
              key={`${heading.line}-${index}-${heading.text}`}
              onClick={() => onHeadingSelect(heading.line)}
              style={{
                "--outline-depth": Math.max(0, Math.min(heading.depth - 1, 5)),
              } as CSSProperties}
              type="button"
            >
              <span className="document-outline-heading">{heading.text}</span>
              <span className="document-outline-line">L{heading.line}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
});

const DocumentAgentPanel = memo(function DocumentAgentPanel({
  activeActionKind,
  activeActionProposalId,
  activeProvider,
  activeProviderAction,
  activeProviderRunId,
  activeProviderStreamedText,
  errorMessage,
  isDirty,
  isExpanded,
  isProviderRunning,
  isThreadSaving,
  onAcceptProposal,
  onCancelProviderRun,
  onComment,
  onPromptChange,
  onProviderAction,
  onRejectProposal,
  onThreadSelect,
  onToggle,
  prompt,
  preferredAgentProvider,
  proposalActionErrorMessage,
  proposals,
  reviewPasses,
  selectedReviewPassName,
  selectedThreadId,
  setPreferredAgentProvider,
  setSelectedReviewPassName,
  threads,
}: {
  activeActionKind: "accept" | "reject" | null;
  activeActionProposalId: string | null;
  activeProvider: AgentProviderId | null;
  activeProviderAction: ProviderDocumentActionKind | null;
  activeProviderRunId: string | null;
  activeProviderStreamedText: string;
  errorMessage: string | null;
  isDirty: boolean;
  isExpanded: boolean;
  isProviderRunning: boolean;
  isThreadSaving: boolean;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onCancelProviderRun: (runId: string | null) => Promise<void>;
  onComment: () => void | Promise<void>;
  onPromptChange: Dispatch<SetStateAction<string>>;
  onProviderAction: (
    provider: AgentProviderId,
    action: ProviderDocumentActionKind,
  ) => void | Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
  onThreadSelect: (threadId: string | null) => void;
  onToggle: () => void;
  prompt: string;
  preferredAgentProvider: AgentProviderId;
  proposalActionErrorMessage: string | null;
  proposals: ProposalRecord[];
  reviewPasses: ReviewPassSummary[];
  selectedReviewPassName: string | null;
  selectedThreadId: string | null;
  setPreferredAgentProvider: (provider: AgentProviderId) => void;
  setSelectedReviewPassName: (passName: string | null) => void;
  threads: ThreadRecord[];
}) {
  const selectedProvider = activeProvider ?? preferredAgentProvider;
  const hasComposerText = Boolean(prompt.trim());
  const canComment = hasComposerText && !isThreadSaving;
  const canRun = hasComposerText && !isProviderRunning && !isThreadSaving && !isDirty;
  const threadCount = threads.length;

  return (
    <section className={`document-agent-panel ${isExpanded ? "is-expanded" : "is-collapsed"}`}>
      <button
        aria-expanded={isExpanded}
        className="document-agent-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className="document-agent-toggle-title">Whole Document</span>
        <span className="document-agent-toggle-row">
          <span className="document-agent-toggle-meta">
            {threadCount
              ? `${threadCount} document check${threadCount === 1 ? "" : "s"}`
              : "Codex / Claude Code"}
          </span>
          <span className="document-agent-toggle-action">{isExpanded ? "Hide" : "Prompt"}</span>
        </span>
      </button>

      {isExpanded ? (
        <div className="document-agent-body">
          <textarea
            className="thread-textarea comment-dock-textarea document-agent-input"
            onChange={(event) => onPromptChange(event.currentTarget.value)}
            placeholder="Comment on the whole document..."
            rows={4}
            value={prompt}
          />
          <div className="thread-composer-actions document-agent-actions">
            <button
              className="primary-button"
              disabled={!canComment}
              onClick={() => void onComment()}
              type="button"
            >
              Comment
            </button>
            <ProviderToggle
              disabled={isProviderRunning}
              onChange={setPreferredAgentProvider}
              provider={selectedProvider}
            />
            <ReviewPassSelect
              disabled={isProviderRunning}
              onChange={setSelectedReviewPassName}
              reviewPasses={reviewPasses}
              selectedPassName={selectedReviewPassName}
            />
            <button
              className="ghost-button"
              disabled={!canRun}
              onClick={() => void onProviderAction(selectedProvider, "feedback")}
              type="button"
            >
              {activeProviderAction === "feedback" && activeProvider
                ? `Asking ${formatProviderDisplayName(activeProvider)}...`
                : "Ask"}
            </button>
            <button
              className="ghost-button"
              disabled={!canRun}
              onClick={() => void onProviderAction(selectedProvider, "revise")}
              type="button"
            >
              {activeProviderAction === "revise" && activeProvider
                ? `Revising document with ${formatProviderDisplayName(activeProvider)}...`
                : "Revise Document"}
            </button>
          </div>
          {isProviderRunning && activeProvider ? (
            <AgentRunningCard
              action={activeProviderAction}
              onStop={onCancelProviderRun}
              provider={activeProvider}
              runId={activeProviderRunId}
              scope="document"
              streamedText={activeProviderStreamedText}
            />
          ) : null}
          {isDirty ? (
            <p className="inline-thread-status agent-action-note">
              Save to enable agent actions.
            </p>
          ) : null}
          {errorMessage ? (
            <p className="inline-thread-status agent-action-error">{errorMessage}</p>
          ) : null}
          {threads.length ? (
            <div className="document-agent-thread-list">
              <p className="document-agent-thread-list-label">Document checks</p>
              {threads.map((thread) => (
                <button
                  className={`document-agent-thread-button ${
                    selectedThreadId === thread.id ? "is-active" : ""
                  }`}
                  key={thread.id}
                  onClick={() => onThreadSelect(thread.id)}
                  type="button"
                >
                  <span className="document-agent-thread-title">
                    {formatDocumentAgentThreadTitle(thread)}
                  </span>
                  <span className="document-agent-thread-meta">
                    {formatDocumentAgentThreadMeta(thread)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <ThreadProposalList
            activeActionKind={activeActionKind}
            activeActionProposalId={activeActionProposalId}
            errorMessage={proposalActionErrorMessage}
            onAcceptProposal={onAcceptProposal}
            onRejectProposal={onRejectProposal}
            proposals={proposals}
          />
        </div>
      ) : null}
    </section>
  );
});

function ProviderToggle({
  disabled,
  onChange,
  provider,
}: {
  disabled: boolean;
  onChange: (provider: AgentProviderId) => void;
  provider: AgentProviderId;
}) {
  return (
    <div aria-label="Agent provider" className="provider-toggle" role="group">
      <button
        aria-pressed={provider === "codex"}
        className={provider === "codex" ? "on" : undefined}
        disabled={disabled}
        onClick={() => onChange("codex")}
        type="button"
      >
        Codex
      </button>
      <button
        aria-pressed={provider === "claude"}
        className={provider === "claude" ? "on" : undefined}
        disabled={disabled}
        onClick={() => onChange("claude")}
        type="button"
      >
        Claude
      </button>
    </div>
  );
}

function ReviewPassSelect({
  disabled,
  onChange,
  reviewPasses,
  selectedPassName,
}: {
  disabled: boolean;
  onChange: (passName: string | null) => void;
  reviewPasses: ReviewPassSummary[];
  selectedPassName: string | null;
}) {
  if (!reviewPasses.length) {
    return null;
  }

  return (
    <label className="review-pass-select">
      <span>Pass</span>
      <select
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value || null)}
        value={selectedPassName ?? ""}
      >
        <option value="">General</option>
        {reviewPasses.map((reviewPass) => (
          <option key={reviewPass.name} value={reviewPass.name}>
            {reviewPass.title}
          </option>
        ))}
      </select>
    </label>
  );
}

const AgentRunningCard = memo(function AgentRunningCard({
  action,
  onStop,
  provider,
  runId,
  scope,
  streamedText,
}: {
  action: ProviderDocumentActionKind | ProviderThreadActionKind | null;
  onStop: (runId: string | null) => Promise<void>;
  provider: AgentProviderId;
  runId: string | null;
  scope: "document" | "thread";
  streamedText: string;
}) {
  const verb = action === "revise" ? "Drafting revision" : "Reading context";
  const hasStreamedText = streamedText.trim().length > 0;

  return (
    <div className="agent-running-card" role="status">
      <div className="agent-running-label">
        <span className="agent-running-label-text">
          <span>{formatProviderDisplayName(provider)}</span>
          <span aria-hidden="true">·</span>
          <span>{verb}</span>
          <span aria-hidden="true">·</span>
          <span>{scope}</span>
        </span>
        <button
          className="ghost-button agent-stop-button"
          disabled={!runId}
          onClick={() => void onStop(runId)}
          type="button"
        >
          Stop
        </button>
      </div>
      {hasStreamedText ? (
        <pre className="agent-running-stream">{streamedText}</pre>
      ) : (
        <>
          <span aria-hidden="true" className="agent-running-line" />
          <span aria-hidden="true" className="agent-running-line is-short" />
          <span aria-hidden="true" className="agent-running-line" />
        </>
      )}
    </div>
  );
});

const ThreadProposalList = memo(function ThreadProposalList({
  activeActionKind,
  activeActionProposalId,
  errorMessage,
  onAcceptProposal,
  onRejectProposal,
  proposals,
  showFullAssistantMessages = false,
}: {
  activeActionKind: "accept" | "reject" | null;
  activeActionProposalId: string | null;
  errorMessage: string | null;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
  proposals: ProposalRecord[];
  showFullAssistantMessages?: boolean;
}) {
  if (!proposals.length && !errorMessage) {
    return null;
  }

  return (
    <div className="proposal-list thread-proposal-list">
      {errorMessage ? <p className="proposal-error-text">{errorMessage}</p> : null}
      {proposals.map((proposal) => {
        const isAccepting =
          activeActionKind === "accept" && activeActionProposalId === proposal.id;
        const isRejecting =
          activeActionKind === "reject" && activeActionProposalId === proposal.id;

        return (
          <ProposalReviewCard
            isAccepting={isAccepting}
            isRejecting={isRejecting}
            key={proposal.id}
            onAcceptProposal={onAcceptProposal}
            onRejectProposal={onRejectProposal}
            proposal={proposal}
            showFullAssistantMessages={showFullAssistantMessages}
          />
        );
      })}
    </div>
  );
});

const ProposalReviewCard = memo(function ProposalReviewCard({
  isAccepting,
  isRejecting,
  onAcceptProposal,
  onRejectProposal,
  proposal,
  showFullAssistantMessages,
}: {
  isAccepting: boolean;
  isRejecting: boolean;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
  proposal: ProposalRecord;
  showFullAssistantMessages: boolean;
}) {
  const [editedDocumentText, setEditedDocumentText] = useState(
    proposal.updatedDocumentText ?? "",
  );
  const isPending = proposal.status === "pending";
  const assistantMessage = proposal.assistantMessage.trim();
  const shouldShowAssistantMessage =
    assistantMessage.length > 0 && assistantMessage !== proposal.summary.trim();
  const hasEditableDocument = isPending && proposal.updatedDocumentText !== null;
  const editedOverride =
    hasEditableDocument && editedDocumentText !== proposal.updatedDocumentText
      ? editedDocumentText
      : undefined;

  useEffect(() => {
    setEditedDocumentText(proposal.updatedDocumentText ?? "");
  }, [proposal.id, proposal.updatedDocumentText]);

  return (
    <article className="proposal-card">
      <div className="proposal-action-row">
        <span className={`proposal-status-pill ${proposal.status}`}>{proposal.status}</span>
        <span className="thread-helper-text">{proposal.adapterId}</span>
      </div>
      {proposal.summary ? <p className="proposal-message">{proposal.summary}</p> : null}
      {shouldShowAssistantMessage ? (
        <details className="proposal-response-details" open={showFullAssistantMessages}>
          <summary>Agent response</summary>
          <div className="proposal-response-body">{renderThreadMessageBody(assistantMessage)}</div>
        </details>
      ) : null}
      {proposal.errorMessage ? (
        <p className="proposal-error-text">{proposal.errorMessage}</p>
      ) : null}
      {proposal.warnings.length ? (
        <div className="proposal-warning-block">
          {proposal.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
      {proposal.computedDiff ? (
        <details className="proposal-details">
          <summary>Diff preview</summary>
          <ProposalDiffPreview
            diffText={proposal.computedDiff}
            editableText={hasEditableDocument ? editedDocumentText : undefined}
            isEditable={hasEditableDocument}
            onEditableTextChange={setEditedDocumentText}
          />
        </details>
      ) : null}
      <div className="proposal-actions">
        <button
          className="primary-button"
          disabled={!isPending || isAccepting || isRejecting}
          onClick={() => void onAcceptProposal(proposal.id, editedOverride)}
        >
          {isAccepting ? "Accepting..." : "Accept"}
        </button>
        <button
          className="ghost-button"
          disabled={!isPending || isAccepting || isRejecting}
          onClick={() => void onRejectProposal(proposal.id)}
        >
          {isRejecting ? "Rejecting..." : "Reject"}
        </button>
      </div>
    </article>
  );
});

function formatMessageAuthor(message: MessageRecord) {
  return message.agentId ?? message.authorName;
}

async function confirmThreadDelete() {
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return confirm("Delete this thread and its messages? This cannot be undone.", {
      cancelLabel: "Cancel",
      kind: "warning",
      okLabel: "Delete",
      title: "Delete thread",
    });
  } catch {
    return false;
  }
}

function formatProviderDisplayName(provider: AgentProviderId) {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function getThreadMessageClassName(message: MessageRecord) {
  const tone =
    message.authorType === "assistant" || message.agentId
      ? "thread-message--assistant"
      : message.authorType === "system"
        ? "thread-message--system"
        : "thread-message--user";

  return `thread-message ${tone}`;
}

function formatDocumentAgentThreadTitle(thread: ThreadRecord) {
  const firstMessage = thread.messages[0]?.body.trim();
  const fallback = firstMessage || thread.title || "Document check";
  return truncateSingleLine(fallback, 72);
}

function formatDocumentAgentThreadMeta(thread: ThreadRecord) {
  const lastMessage = thread.messages[thread.messages.length - 1];
  const author = lastMessage ? formatMessageAuthor(lastMessage) : "thread";
  const count = thread.messages.length;
  const countLabel = `${count} message${count === 1 ? "" : "s"}`;
  const date = timestampFormatter.format(new Date(thread.updatedAt));
  return `${author} · ${countLabel} · ${date}`;
}

function isInteractiveCommentTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      'a, button, details, input, select, summary, textarea, [contenteditable="true"], [role="button"]',
    ),
  );
}

function truncateSingleLine(value: string, maxLength: number) {
  const normalized = value.split(/\s+/).filter(Boolean).join(" ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isDocumentLevelThread(thread: ThreadRecord) {
  return thread.anchor.kind === "document" || thread.tags.includes("document");
}

function renderThreadMessageBody(body: string): ReactNode[] {
  return parseThreadMessageBodyLinks(body).map((segment, index) => {
    if (segment.kind === "text") {
      return segment.text;
    }

    return (
      <a
        className="thread-message-link"
        href={segment.href}
        key={`${segment.href}-${index}`}
        onClick={handleThreadMessageLinkClick}
        rel="noreferrer"
        target="_blank"
      >
        {segment.text}
      </a>
    );
  });
}

function handleThreadMessageLinkClick(event: ReactMouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  event.stopPropagation();
  void openThreadMessageLink(event.currentTarget.href);
}

async function openThreadMessageLink(href: string) {
  try {
    await invokeBackend("open_external_url", { url: href });
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

export function parseThreadMessageBodyLinks(body: string): ThreadMessageBodySegment[] {
  const segments: ThreadMessageBodySegment[] = [];
  let cursor = 0;
  THREAD_MESSAGE_LINK_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = THREAD_MESSAGE_LINK_PATTERN.exec(body))) {
    const matchText = match[0];
    const markdownLabel = match[1];
    const markdownHref = match[2];
    const isMarkdownLink = markdownLabel !== undefined && markdownHref !== undefined;

    if (match.index > cursor) {
      segments.push({
        kind: "text",
        text: body.slice(cursor, match.index),
      });
    }

    if (isMarkdownLink) {
      const href = normalizeThreadMessageHref(markdownHref);
      if (href) {
        segments.push({
          href,
          kind: "link",
          text: markdownLabel,
        });
      } else {
        segments.push({
          kind: "text",
          text: matchText,
        });
      }
      cursor = THREAD_MESSAGE_LINK_PATTERN.lastIndex;
      continue;
    }

    const { hrefCandidate, trailingText } = splitTrailingUrlPunctuation(matchText);
    const href = normalizeThreadMessageHref(hrefCandidate);
    if (href) {
      segments.push({
        href,
        kind: "link",
        text: hrefCandidate,
      });
      if (trailingText) {
        segments.push({
          kind: "text",
          text: trailingText,
        });
      }
    } else {
      segments.push({
        kind: "text",
        text: matchText,
      });
    }
    cursor = THREAD_MESSAGE_LINK_PATTERN.lastIndex;
  }

  if (cursor < body.length) {
    segments.push({
      kind: "text",
      text: body.slice(cursor),
    });
  }

  return segments;
}

function resolveDocumentImageSource(source: string, document: DocumentPayload | null) {
  const normalizedSource = source.trim();
  if (
    !normalizedSource ||
    /^(?:https?:|data:|blob:|asset:)/i.test(normalizedSource) ||
    !document ||
    !isDesktopBackend()
  ) {
    return normalizedSource;
  }

  const [pathPart, suffix = ""] = splitImageSourceSuffix(normalizedSource);
  const absolutePath = pathPart.startsWith("/")
    ? pathPart
    : normalizeAbsolutePath(`${document.absolutePath.slice(0, document.absolutePath.lastIndexOf("/") + 1)}${pathPart}`);

  return `${convertLocalFileSrc(absolutePath)}${suffix}`;
}

function splitImageSourceSuffix(source: string): [string, string] {
  const suffixIndex = source.search(/[?#]/);
  if (suffixIndex === -1) {
    return [source, ""];
  }

  return [source.slice(0, suffixIndex), source.slice(suffixIndex)];
}

function normalizeAbsolutePath(path: string) {
  const segments: string[] = [];
  const isAbsolute = path.startsWith("/");

  path.split("/").forEach((segment) => {
    if (!segment || segment === ".") {
      return;
    }
    if (segment === "..") {
      segments.pop();
      return;
    }
    segments.push(segment);
  });

  return `${isAbsolute ? "/" : ""}${segments.join("/")}`;
}

function normalizeThreadMessageHref(rawHref: string) {
  const href = rawHref.startsWith("<") && rawHref.endsWith(">")
    ? rawHref.slice(1, -1)
    : rawHref;

  try {
    const parsedUrl = new URL(href);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function splitTrailingUrlPunctuation(rawUrl: string) {
  let hrefCandidate = rawUrl;
  let trailingText = "";

  while (/[.,!?;:]$/.test(hrefCandidate)) {
    trailingText = hrefCandidate[hrefCandidate.length - 1] + trailingText;
    hrefCandidate = hrefCandidate.slice(0, -1);
  }

  while (hrefCandidate.endsWith(")") && hasUnmatchedClosingParenthesis(hrefCandidate)) {
    trailingText = ")" + trailingText;
    hrefCandidate = hrefCandidate.slice(0, -1);
  }

  return { hrefCandidate, trailingText };
}

function hasUnmatchedClosingParenthesis(value: string) {
  let balance = 0;
  for (const character of value) {
    if (character === "(") {
      balance += 1;
    } else if (character === ")") {
      balance -= 1;
    }
  }
  return balance < 0;
}

function clampDockOffset(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
