import { useCallback, useEffect, useMemo } from "react";
import { createAnchor, defaultThreadTitle } from "../lib/anchor";
import { invokeBackend } from "../lib/backend";
import { getErrorMessage } from "../lib/errorMessage";
import {
  clearReviewNotificationBadge,
  setReviewNotificationOpenHandler,
} from "../lib/reviewNotifications";
import { threadsForDocument, useReviewDataStore } from "../stores/reviewDataStore";
import { useThreadStore } from "../stores/threadStore";
import type { AnchorRecord, EditorSelectionSnapshot, ThreadRecord } from "../types/thread";
import type { DocumentPayload, WorkspaceSnapshot } from "../types/workspace";

interface UseThreadsOptions {
  activeDocument: DocumentPayload | null;
  enabled?: boolean;
  workspace: WorkspaceSnapshot | null;
}

export function useThreads({
  activeDocument,
  enabled = true,
  workspace,
}: UseThreadsOptions) {
  const errorMessage = useThreadStore((state) => state.errorMessage);
  const isThreadLoading = useThreadStore((state) => state.isLoading);
  const isSaving = useThreadStore((state) => state.isSaving);
  const selectedThreadId = useThreadStore((state) => state.selectedThreadId);
  const threads = useThreadStore((state) => state.threads);
  const removeThreadFromStore = useThreadStore((state) => state.removeThread);
  const resetThreadStore = useThreadStore((state) => state.reset);
  const selectThreadInStore = useThreadStore((state) => state.selectThread);
  const setThreadErrorMessage = useThreadStore((state) => state.setErrorMessage);
  const setThreadIsLoading = useThreadStore((state) => state.setIsLoading);
  const setThreadIsSaving = useThreadStore((state) => state.setIsSaving);
  const setThreadsInStore = useThreadStore((state) => state.setThreads);
  const upsertThreadInStore = useThreadStore((state) => state.upsertThread);
  const reviewThreads = useReviewDataStore((state) => state.threads);
  const reviewIsLoading = useReviewDataStore((state) => state.isLoading);
  const setDocumentThreads = useReviewDataStore((state) => state.setDocumentThreads);
  const upsertReviewThread = useReviewDataStore((state) => state.upsertThread);
  const removeReviewThread = useReviewDataStore((state) => state.removeThread);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!workspace || !activeDocument) {
      resetThreadStore();
      return;
    }

    setThreadsInStore(threadsForDocument(reviewThreads, activeDocument.id));
  }, [
    activeDocument?.id,
    enabled,
    resetThreadStore,
    reviewThreads,
    setThreadsInStore,
    workspace?.rootPath,
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!workspace || !activeDocument) {
      return;
    }

    const workspaceRoot = workspace.rootPath;
    const documentRelativePath = activeDocument.relativePath;
    const refreshOnAppReturn = () => {
      void clearReviewNotificationBadge();
    };
    const stopNotificationOpenHandling = setReviewNotificationOpenHandler((target) => {
      if (
        target.workspaceRoot !== workspaceRoot ||
        target.documentRelativePath !== documentRelativePath
      ) {
        return;
      }

      selectThreadInStore(target.threadId);
    });

    window.addEventListener("focus", refreshOnAppReturn);
    document.addEventListener("visibilitychange", refreshOnVisibilityChange);

    return () => {
      window.removeEventListener("focus", refreshOnAppReturn);
      document.removeEventListener("visibilitychange", refreshOnVisibilityChange);
      stopNotificationOpenHandling();
    };

    function refreshOnVisibilityChange() {
      if (document.visibilityState !== "visible") {
        return;
      }

      refreshOnAppReturn();
    }
  }, [activeDocument?.relativePath, enabled, selectThreadInStore, workspace?.rootPath]);

  async function fetchThreads(
    workspaceRoot = workspace?.rootPath,
    documentId = activeDocument?.id,
  ) {
    if (!workspaceRoot || !documentId) {
      return [];
    }

    return invokeBackend<ThreadRecord[]>("load_threads", {
      documentId,
      workspaceRoot,
    });
  }

  async function fetchThread(
    workspaceRoot = workspace?.rootPath,
    threadId?: string | null,
  ) {
    if (!workspaceRoot || !threadId) {
      return null;
    }

    return invokeBackend<ThreadRecord>("load_thread", {
      threadId,
      workspaceRoot,
    });
  }

  async function loadThreads(workspaceRoot = workspace?.rootPath, documentId = activeDocument?.id) {
    if (!workspaceRoot || !documentId) {
      return;
    }

    setThreadIsLoading(true);
    setThreadErrorMessage(null);

    try {
      const threads = await fetchThreads(workspaceRoot, documentId);
      setDocumentThreads(documentId, threads);
      setThreadsInStore(threads);
    } catch (error) {
      setThreadErrorMessage(getErrorMessage(error, "Unable to load threads for this document."));
    } finally {
      setThreadIsLoading(false);
    }
  }

  async function createThread(selection: AnchorRecord, body: string) {
    if (!workspace || !activeDocument) {
      return;
    }

    setThreadIsSaving(true);
    setThreadErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("create_thread", {
        anchor: selection,
        body,
        documentId: activeDocument.id,
        title: defaultThreadTitle(selection.quote),
        workspaceRoot: workspace.rootPath,
      });
      upsertReviewThread(thread);
      upsertThreadInStore(thread);
    } catch (error) {
      setThreadErrorMessage(getErrorMessage(error, "Unable to create a new thread."));
    } finally {
      setThreadIsSaving(false);
    }
  }

  async function createThreadFromSelection(
    body: string,
    selection: EditorSelectionSnapshot,
    content: string,
  ) {
    if (!activeDocument) {
      return;
    }

    const anchor = await createAnchor(activeDocument, content, selection);
    await createThread(anchor, body);
  }

  async function createDocumentThread(body: string) {
    if (!workspace || !activeDocument || !body.trim()) {
      return;
    }

    const anchor: AnchorRecord = {
      baseContentHash: activeDocument.currentContentHash,
      blockFingerprint: "",
      confidence: 1,
      endColumn: 1,
      endLine: 1,
      endOffsetUtf16: 0,
      footnote: null,
      headingPath: [],
      kind: "document",
      prefixContext: "",
      quote: `Entire document: ${activeDocument.relativePath}`,
      startColumn: 1,
      startLine: 1,
      startOffsetUtf16: 0,
      state: "attached",
      suffixContext: "",
    };

    setThreadIsSaving(true);
    setThreadErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("create_thread", {
        anchor,
        body,
        documentId: activeDocument.id,
        title: documentThreadTitle(body),
        workspaceRoot: workspace.rootPath,
      });
      upsertReviewThread(thread);
      upsertThreadInStore(thread);
      selectThreadInStore(thread.id);
    } catch (error) {
      setThreadErrorMessage(getErrorMessage(error, "Unable to create a document comment."));
    } finally {
      setThreadIsSaving(false);
    }
  }

  async function addReply(threadId: string, body: string) {
    if (!workspace || !body.trim()) {
      return;
    }

    setThreadIsSaving(true);
    setThreadErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("add_thread_message", {
        body,
        kind: "reply",
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      upsertReviewThread(thread);
      upsertThreadInStore(thread);
    } catch (error) {
      setThreadErrorMessage(getErrorMessage(error, "Unable to add a reply to this thread."));
    } finally {
      setThreadIsSaving(false);
    }
  }

  async function resolveThread(threadId: string) {
    if (!workspace) {
      return;
    }

    setThreadIsSaving(true);
    setThreadErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("resolve_thread", {
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      upsertReviewThread(thread);
      upsertThreadInStore(thread);
    } catch (error) {
      setThreadErrorMessage(getErrorMessage(error, "Unable to resolve this thread."));
    } finally {
      setThreadIsSaving(false);
    }
  }

  async function deleteThread(threadId: string) {
    if (!workspace) {
      return;
    }

    setThreadIsSaving(true);
    setThreadErrorMessage(null);

    try {
      await invokeBackend<ThreadRecord>("delete_thread", {
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      removeReviewThread(threadId);
      removeThreadFromStore(threadId);
    } catch (error) {
      setThreadErrorMessage(getErrorMessage(error, "Unable to delete this thread."));
    } finally {
      setThreadIsSaving(false);
    }
  }

  async function reopenThread(threadId: string) {
    if (!workspace) {
      return;
    }

    setThreadIsSaving(true);
    setThreadErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("reopen_thread", {
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      upsertReviewThread(thread);
      upsertThreadInStore(thread);
    } catch (error) {
      setThreadErrorMessage(getErrorMessage(error, "Unable to reopen this thread."));
    } finally {
      setThreadIsSaving(false);
    }
  }

  async function loadThread(threadId: string | null) {
    const thread = await fetchThread(workspace?.rootPath, threadId);
    if (thread) {
      upsertReviewThread(thread);
      upsertThreadInStore(thread);
    }
    return thread;
  }

  function selectThread(threadId: string | null) {
    selectThreadInStore(threadId);
  }

  const stableAddReply = useCallback(
    (threadId: string, body: string) => addReply(threadId, body),
    [workspace?.rootPath],
  );
  const stableCreateDocumentThread = useCallback(
    (body: string) => createDocumentThread(body),
    [activeDocument?.currentContentHash, activeDocument?.id, activeDocument?.relativePath, workspace?.rootPath],
  );
  const stableCreateThreadFromSelection = useCallback(
    (body: string, selection: EditorSelectionSnapshot, content: string) =>
      createThreadFromSelection(body, selection, content),
    [activeDocument?.currentContentHash, activeDocument?.id, workspace?.rootPath],
  );
  const stableDeleteThread = useCallback(
    (threadId: string) => deleteThread(threadId),
    [activeDocument?.id, workspace?.rootPath],
  );
  const stableLoadThread = useCallback(
    (threadId: string | null) => loadThread(threadId),
    [workspace?.rootPath],
  );
  const stableLoadThreads = useCallback(
    (workspaceRoot = workspace?.rootPath, documentId = activeDocument?.id) =>
      loadThreads(workspaceRoot, documentId),
    [activeDocument?.id, workspace?.rootPath],
  );
  const stableReopenThread = useCallback(
    (threadId: string) => reopenThread(threadId),
    [workspace?.rootPath],
  );
  const stableResolveThread = useCallback(
    (threadId: string) => resolveThread(threadId),
    [workspace?.rootPath],
  );
  const stableSelectThread = useCallback((threadId: string | null) => selectThread(threadId), []);

  return useMemo(
    () => ({
      errorMessage,
      isLoading: isThreadLoading || reviewIsLoading,
      isSaving,
      removeThread: removeThreadFromStore,
      reset: resetThreadStore,
      selectedThreadId,
      setErrorMessage: setThreadErrorMessage,
      setIsLoading: setThreadIsLoading,
      setIsSaving: setThreadIsSaving,
      setThreads: setThreadsInStore,
      threads,
      upsertThread: upsertThreadInStore,
      addReply: stableAddReply,
      createDocumentThread: stableCreateDocumentThread,
      createThreadFromSelection: stableCreateThreadFromSelection,
      deleteThread: stableDeleteThread,
      loadThread: stableLoadThread,
      loadThreads: stableLoadThreads,
      reopenThread: stableReopenThread,
      resolveThread: stableResolveThread,
      selectThread: stableSelectThread,
    }),
    [
      stableAddReply,
      stableCreateDocumentThread,
      stableCreateThreadFromSelection,
      stableDeleteThread,
      stableLoadThread,
      stableLoadThreads,
      stableReopenThread,
      stableResolveThread,
      stableSelectThread,
      errorMessage,
      isSaving,
      isThreadLoading,
      removeThreadFromStore,
      reviewIsLoading,
      resetThreadStore,
      selectedThreadId,
      setThreadErrorMessage,
      setThreadIsLoading,
      setThreadIsSaving,
      setThreadsInStore,
      threads,
      upsertThreadInStore,
    ],
  );
}

function documentThreadTitle(body: string) {
  const normalized = body.split(/\s+/).filter(Boolean).join(" ");
  if (!normalized) {
    return "Document comment";
  }

  const prefix = normalized.slice(0, 52);
  return normalized.length > 52 ? `Document comment: ${prefix}...` : `Document comment: ${prefix}`;
}
