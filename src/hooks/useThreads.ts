import { useCallback, useEffect, useMemo, useRef } from "react";
import { createAnchor, defaultThreadTitle } from "../lib/anchor";
import { invokeBackend, watchBackend } from "../lib/backend";
import { getErrorMessage } from "../lib/errorMessage";
import {
  clearReviewNotificationBadge,
  collectReviewNotificationItems,
  notifyReviewUpdates,
  setReviewNotificationOpenHandler,
} from "../lib/reviewNotifications";
import { getScopedWatchTarget } from "../lib/watchTarget";
import { useThreadStore } from "../stores/threadStore";
import type { AnchorRecord, EditorSelectionSnapshot, ThreadRecord } from "../types/thread";
import type { DocumentPayload, WorkspaceSnapshot } from "../types/workspace";

const EMPTY_THREAD_SIGNATURE = "";
const SETTLED_THREAD_REFRESH_DELAY_MS = 350;

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
  const store = useThreadStore();
  const threadsSignatureRef = useRef(EMPTY_THREAD_SIGNATURE);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!workspace || !activeDocument) {
      threadsSignatureRef.current = EMPTY_THREAD_SIGNATURE;
      store.reset();
      return;
    }

    void loadThreads(workspace.rootPath, activeDocument.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocument?.currentContentHash, activeDocument?.id, enabled, workspace?.rootPath]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!workspace || !activeDocument) {
      return;
    }

    const threadsDirectoryPath = `${workspace.mdreviewPath}/threads`;
    const workspaceRoot = workspace.rootPath;
    const documentId = activeDocument.id;
    const documentRelativePath = activeDocument.relativePath;
    let cancelled = false;
    let isRefreshing = false;
    let shouldRefreshAgain = false;
    let settledRefreshTimeoutId: number | null = null;
    let hasCompletedInitialRefresh = false;

    async function refreshThreadsIfChanged() {
      if (cancelled) {
        return;
      }

      if (isRefreshing) {
        shouldRefreshAgain = true;
        return;
      }

      isRefreshing = true;

      try {
        const nextSignature = await fetchThreadUpdateSignature(workspaceRoot, documentId);

        if (cancelled) {
          return;
        }

        if (nextSignature === threadsSignatureRef.current) {
          return;
        }

        const previousThreads = useThreadStore.getState().threads;
        const threads = await fetchThreads(workspaceRoot, documentId);

        if (cancelled) {
          return;
        }

        threadsSignatureRef.current = nextSignature;
        store.setThreads(threads);
        if (hasCompletedInitialRefresh) {
          void notifyReviewUpdates(
            collectReviewNotificationItems({
              documentRelativePath,
              nextThreads: threads,
              previousThreads,
              workspaceRoot,
            }),
          );
        }
      } catch (error) {
        if (!cancelled) {
          store.setErrorMessage(getErrorMessage(error, "Unable to refresh threads for this document."));
        }
      } finally {
        isRefreshing = false;

        if (!cancelled && shouldRefreshAgain) {
          shouldRefreshAgain = false;
          void refreshThreadsIfChanged();
        }

        hasCompletedInitialRefresh = true;
      }
    }

    let stopWatching: (() => void) | null = null;
    const watchTarget = getScopedWatchTarget(threadsDirectoryPath, {
      delayMs: 200,
      recursive: true,
    });
    const refreshOnAppReturn = () => {
      if (cancelled || useThreadStore.getState().isSaving) {
        return;
      }

      void clearReviewNotificationBadge();
      void refreshThreadsIfChanged();
    };
    const stopNotificationOpenHandling = setReviewNotificationOpenHandler((target) => {
      if (
        target.workspaceRoot !== workspaceRoot ||
        target.documentRelativePath !== documentRelativePath
      ) {
        return;
      }

      store.selectThread(target.threadId);
    });

    void refreshThreadsIfChanged();
    void watchBackend(
      watchTarget.path,
      () => {
        if (cancelled || useThreadStore.getState().isSaving) {
          return;
        }

        void refreshThreadsIfChanged();
        if (settledRefreshTimeoutId !== null) {
          window.clearTimeout(settledRefreshTimeoutId);
        }
        // CLI writes use atomic rename semantics; a second settled refresh avoids
        // missing updates when the first watcher event arrives before the final file lands.
        settledRefreshTimeoutId = window.setTimeout(() => {
          settledRefreshTimeoutId = null;
          if (cancelled || useThreadStore.getState().isSaving) {
            return;
          }

          void refreshThreadsIfChanged();
        }, SETTLED_THREAD_REFRESH_DELAY_MS);
      },
      watchTarget.options,
    )
      .then((unwatch) => {
        if (cancelled) {
          void unwatch();
          return;
        }

        stopWatching = unwatch;
      })
      .catch((error) => {
        if (!cancelled) {
          store.setErrorMessage(getErrorMessage(error, "Unable to watch thread changes."));
        }
      });

    window.addEventListener("focus", refreshOnAppReturn);
    document.addEventListener("visibilitychange", refreshOnVisibilityChange);

    return () => {
      cancelled = true;
      if (settledRefreshTimeoutId !== null) {
        window.clearTimeout(settledRefreshTimeoutId);
      }
      window.removeEventListener("focus", refreshOnAppReturn);
      document.removeEventListener("visibilitychange", refreshOnVisibilityChange);
      stopWatching?.();
      stopNotificationOpenHandling();
    };

    function refreshOnVisibilityChange() {
      if (document.visibilityState !== "visible") {
        return;
      }

      refreshOnAppReturn();
    }
  }, [activeDocument?.id, enabled, workspace?.mdreviewPath, workspace?.rootPath]);

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

  async function fetchThreadUpdateSignature(
    workspaceRoot = workspace?.rootPath,
    documentId = activeDocument?.id,
  ) {
    if (!workspaceRoot || !documentId) {
      return EMPTY_THREAD_SIGNATURE;
    }

    return invokeBackend<string>("check_thread_update_signature", {
      documentId,
      workspaceRoot,
    });
  }

  async function loadThreads(workspaceRoot = workspace?.rootPath, documentId = activeDocument?.id) {
    if (!workspaceRoot || !documentId) {
      return;
    }

    store.setIsLoading(true);
    store.setErrorMessage(null);

    try {
      const threads = await fetchThreads(workspaceRoot, documentId);
      threadsSignatureRef.current = await fetchThreadUpdateSignature(workspaceRoot, documentId);
      store.setThreads(threads);
    } catch (error) {
      store.setErrorMessage(getErrorMessage(error, "Unable to load threads for this document."));
    } finally {
      store.setIsLoading(false);
    }
  }

  async function createThread(selection: AnchorRecord, body: string) {
    if (!workspace || !activeDocument) {
      return;
    }

    store.setIsSaving(true);
    store.setErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("create_thread", {
        anchor: selection,
        body,
        documentId: activeDocument.id,
        title: defaultThreadTitle(selection.quote),
        workspaceRoot: workspace.rootPath,
      });
      threadsSignatureRef.current = await fetchThreadUpdateSignature(
        workspace.rootPath,
        activeDocument.id,
      );
      store.upsertThread(thread);
    } catch (error) {
      store.setErrorMessage(getErrorMessage(error, "Unable to create a new thread."));
    } finally {
      store.setIsSaving(false);
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

    store.setIsSaving(true);
    store.setErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("create_thread", {
        anchor,
        body,
        documentId: activeDocument.id,
        title: documentThreadTitle(body),
        workspaceRoot: workspace.rootPath,
      });
      threadsSignatureRef.current = await fetchThreadUpdateSignature(
        workspace.rootPath,
        activeDocument.id,
      );
      store.upsertThread(thread);
      store.selectThread(thread.id);
    } catch (error) {
      store.setErrorMessage(getErrorMessage(error, "Unable to create a document comment."));
    } finally {
      store.setIsSaving(false);
    }
  }

  async function addReply(threadId: string, body: string) {
    if (!workspace || !body.trim()) {
      return;
    }

    store.setIsSaving(true);
    store.setErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("add_thread_message", {
        body,
        kind: "reply",
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      threadsSignatureRef.current = await fetchThreadUpdateSignature(
        workspace.rootPath,
        thread.documentId,
      );
      store.upsertThread(thread);
    } catch (error) {
      store.setErrorMessage(getErrorMessage(error, "Unable to add a reply to this thread."));
    } finally {
      store.setIsSaving(false);
    }
  }

  async function resolveThread(threadId: string) {
    if (!workspace) {
      return;
    }

    store.setIsSaving(true);
    store.setErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("resolve_thread", {
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      threadsSignatureRef.current = await fetchThreadUpdateSignature(
        workspace.rootPath,
        thread.documentId,
      );
      store.upsertThread(thread);
    } catch (error) {
      store.setErrorMessage(getErrorMessage(error, "Unable to resolve this thread."));
    } finally {
      store.setIsSaving(false);
    }
  }

  async function deleteThread(threadId: string) {
    if (!workspace) {
      return;
    }

    store.setIsSaving(true);
    store.setErrorMessage(null);

    try {
      await invokeBackend<ThreadRecord>("delete_thread", {
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      threadsSignatureRef.current = await fetchThreadUpdateSignature(
        workspace.rootPath,
        activeDocument?.id,
      );
      store.removeThread(threadId);
    } catch (error) {
      store.setErrorMessage(getErrorMessage(error, "Unable to delete this thread."));
    } finally {
      store.setIsSaving(false);
    }
  }

  async function reopenThread(threadId: string) {
    if (!workspace) {
      return;
    }

    store.setIsSaving(true);
    store.setErrorMessage(null);

    try {
      const thread = await invokeBackend<ThreadRecord>("reopen_thread", {
        threadId,
        workspaceRoot: workspace.rootPath,
      });
      threadsSignatureRef.current = await fetchThreadUpdateSignature(
        workspace.rootPath,
        thread.documentId,
      );
      store.upsertThread(thread);
    } catch (error) {
      store.setErrorMessage(getErrorMessage(error, "Unable to reopen this thread."));
    } finally {
      store.setIsSaving(false);
    }
  }

  async function loadThread(threadId: string | null) {
    const thread = await fetchThread(workspace?.rootPath, threadId);
    if (thread) {
      store.upsertThread(thread);
    }
    return thread;
  }

  function selectThread(threadId: string | null) {
    store.selectThread(threadId);
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
      ...store,
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
      store,
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
