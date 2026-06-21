import { useCallback, useEffect, useRef } from "react";
import { invokeBackend, watchBackend } from "../lib/backend";
import { getErrorMessage } from "../lib/errorMessage";
import {
  clearReviewNotificationBadge,
  collectReviewNotificationItems,
  notifyReviewUpdates,
} from "../lib/reviewNotifications";
import { getScopedWatchTarget } from "../lib/watchTarget";
import {
  threadsForDocument,
  useReviewDataStore,
} from "../stores/reviewDataStore";
import type { ProposalRecord } from "../types/proposal";
import type { ThreadRecord } from "../types/thread";
import type { DocumentPayload, WorkspaceSnapshot } from "../types/workspace";

const SETTLED_REVIEW_REFRESH_DELAY_MS = 350;

interface UseReviewDataOptions {
  activeDocument: DocumentPayload | null;
  enabled?: boolean;
  workspace: WorkspaceSnapshot | null;
}

interface RefreshOptions {
  notify?: boolean;
}

export function useReviewData({
  activeDocument,
  enabled = true,
  workspace,
}: UseReviewDataOptions) {
  const mdreviewPath = workspace?.mdreviewPath ?? null;
  const resetReviewData = useReviewDataStore((state) => state.reset);
  const setReviewData = useReviewDataStore((state) => state.setReviewData);
  const setReviewDataError = useReviewDataStore((state) => state.setErrorMessage);
  const setReviewDataLoading = useReviewDataStore((state) => state.setIsLoading);
  const workspaceRoot = workspace?.rootPath ?? null;
  const activeDocumentRef = useRef(activeDocument);
  const workspaceRootRef = useRef(workspaceRoot);

  useEffect(() => {
    activeDocumentRef.current = activeDocument;
  }, [activeDocument]);

  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
  }, [workspaceRoot]);

  const loadReviewData = useCallback(
    async (options: RefreshOptions = {}) => {
      if (!workspaceRoot) {
        useReviewDataStore.getState().reset();
        return;
      }

      const previousThreads = useReviewDataStore.getState().threads;
      setReviewDataLoading(true);
      setReviewDataError(null);

      try {
        const [threads, proposals] = await Promise.all([
          invokeBackend<ThreadRecord[]>("load_all_threads", {
            workspaceRoot,
          }),
          invokeBackend<ProposalRecord[]>("load_all_proposals", {
            workspaceRoot,
          }),
        ]);

        if (workspaceRootRef.current !== workspaceRoot) {
          return;
        }

        setReviewData({ proposals, threads });

        const currentActiveDocument = activeDocumentRef.current;
        if (options.notify && currentActiveDocument) {
          void notifyReviewUpdates(
            collectReviewNotificationItems({
              documentRelativePath: currentActiveDocument.relativePath,
              nextThreads: threadsForDocument(threads, currentActiveDocument.id),
              previousThreads: threadsForDocument(previousThreads, currentActiveDocument.id),
              workspaceRoot,
            }),
          );
        }
      } catch (error) {
        if (workspaceRootRef.current === workspaceRoot) {
          setReviewDataError(getErrorMessage(error, "Unable to refresh review data."));
        }
      } finally {
        if (workspaceRootRef.current === workspaceRoot) {
          setReviewDataLoading(false);
        }
      }
    },
    [setReviewData, setReviewDataError, setReviewDataLoading, workspaceRoot],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!mdreviewPath || !workspaceRoot) {
      resetReviewData();
      return;
    }

    let cancelled = false;
    let isRefreshing = false;
    let shouldRefreshAgain = false;
    let settledRefreshTimeoutId: number | null = null;
    let hasCompletedInitialRefresh = false;

    async function refreshReviewData(options: RefreshOptions = {}) {
      if (cancelled) {
        return;
      }

      if (isRefreshing) {
        shouldRefreshAgain = true;
        return;
      }

      isRefreshing = true;
      await loadReviewData({
        notify: options.notify && hasCompletedInitialRefresh,
      });
      isRefreshing = false;
      hasCompletedInitialRefresh = true;

      if (!cancelled && shouldRefreshAgain) {
        shouldRefreshAgain = false;
        void refreshReviewData({ notify: true });
      }
    }

    let stopWatching: (() => void) | null = null;
    const watchTarget = getScopedWatchTarget(mdreviewPath, {
      delayMs: 200,
      recursive: true,
    });
    const refreshOnAppReturn = () => {
      if (cancelled) {
        return;
      }

      void clearReviewNotificationBadge();
      void refreshReviewData({ notify: true });
    };

    void refreshReviewData();
    void watchBackend(
      watchTarget.path,
      () => {
        if (cancelled) {
          return;
        }

        void refreshReviewData({ notify: true });
        if (settledRefreshTimeoutId !== null) {
          window.clearTimeout(settledRefreshTimeoutId);
        }
        // Sidecar writes are atomic renames; a settled refresh catches the final file.
        settledRefreshTimeoutId = window.setTimeout(() => {
          settledRefreshTimeoutId = null;
          if (cancelled) {
            return;
          }

          void refreshReviewData({ notify: true });
        }, SETTLED_REVIEW_REFRESH_DELAY_MS);
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
          setReviewDataError(getErrorMessage(error, "Unable to watch review changes."));
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
    };

    function refreshOnVisibilityChange() {
      if (document.visibilityState !== "visible") {
        return;
      }

      refreshOnAppReturn();
    }
  }, [
    enabled,
    loadReviewData,
    mdreviewPath,
    resetReviewData,
    setReviewDataError,
    workspaceRoot,
  ]);

  return {
    loadReviewData,
  };
}
