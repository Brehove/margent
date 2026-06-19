import { useEffect, useRef } from "react";
import { invokeBackend, isDesktopBackend, listenBackend, openBackend, watchBackend, type WatchEvent } from "../lib/backend";
import { measurePerfAsync } from "../lib/devPerf";
import { getErrorMessage } from "../lib/errorMessage";
import {
  forgetRecentWorkspace,
  readRecentWorkspaces,
  rememberRecentWorkspace,
} from "../lib/recentWorkspaces";
import { getParentDirectoryPath, getScopedWatchTarget } from "../lib/watchTarget";
import { useThreadStore } from "../stores/threadStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type {
  AssetImportResult,
  DocumentPayload,
  WorkspaceOpenRequest,
  WorkspaceSnapshot,
} from "../types/workspace";

const WORKSPACE_REFRESH_DELAY_MS = 250;
const SETTLED_DOCUMENT_REFRESH_DELAY_MS = 350;
const WORKSPACE_EXCLUDED_DIRECTORIES = new Set([".mdreview", ".git", "node_modules", "target", "dist"]);
const OPEN_REQUEST_EVENT = "margent://open-request";
let latestWorkspaceRequestToken = 0;

function beginWorkspaceRequest() {
  latestWorkspaceRequestToken += 1;
  return latestWorkspaceRequestToken;
}

function isCurrentWorkspaceRequest(token: number | null | undefined) {
  return token == null || token === latestWorkspaceRequestToken;
}

export function useWorkspaceEffects() {
  const activeDocument = useWorkspaceStore((state) => state.activeDocument);
  const isEditorDirty = useWorkspaceStore((state) => state.isEditorDirty);
  const pendingExternalDocument = useWorkspaceStore((state) => state.pendingExternalDocument);
  const setErrorMessage = useWorkspaceStore((state) => state.setErrorMessage);
  const setPendingExternalDocument = useWorkspaceStore((state) => state.setPendingExternalDocument);
  const isSaving = useWorkspaceStore((state) => state.isSaving);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const isDirty = activeDocument ? isEditorDirty : false;
  const workspaceRoot = workspace?.rootPath ?? null;
  const handledOpenRequestIdsRef = useRef(new Set<number>());

  useEffect(() => {
    if (!isDesktopBackend()) {
      return;
    }

    let cancelled = false;
    let stopListening: (() => void) | null = null;

    async function applyOpenRequest(request: WorkspaceOpenRequest) {
      if (handledOpenRequestIdsRef.current.has(request.id)) {
        return;
      }

      handledOpenRequestIdsRef.current.add(request.id);
      await applyWorkspaceOpenRequest(request);
      if (request.threadId) {
        selectThreadWhenAvailable(request.threadId);
      }
    }

    async function applyOpenRequests(requests: WorkspaceOpenRequest[]) {
      for (const request of requests) {
        if (cancelled) {
          return;
        }

        await applyOpenRequest(request);
      }
    }

    async function restoreRecentWorkspace() {
      const recentWorkspace = readRecentWorkspaces()[0];
      if (!recentWorkspace) {
        return;
      }

      await hydrateWorkspace(recentWorkspace.openedPath ?? recentWorkspace.rootPath, {
        preferredRelativePath: recentWorkspace.activeRelativePath,
        silentFailure: true,
      });
    }

    void invokeBackend<WorkspaceOpenRequest[]>("take_pending_open_requests")
      .then((requests) => {
        if (cancelled) {
          return;
        }

        if (requests.length) {
          void applyOpenRequests(requests);
          return;
        }

        void restoreRecentWorkspace();
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(getErrorMessage(error, "Unable to load pending file-open requests."));
        }
      });

    void listenBackend<WorkspaceOpenRequest>(OPEN_REQUEST_EVENT, (event) => {
      if (cancelled) {
        return;
      }

      void applyOpenRequest(event.payload);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }

        stopListening = unlisten;
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(getErrorMessage(error, "Unable to listen for file-open requests."));
        }
      });

    return () => {
      cancelled = true;
      stopListening?.();
    };
  }, [setErrorMessage]);

  useEffect(() => {
    if (!workspaceRoot || !activeDocument) {
      setPendingExternalDocument(null);
      return;
    }

    const activeAbsolutePath = activeDocument.absolutePath;
    const activeRelativePath = activeDocument.relativePath;
    const knownContentHash = activeDocument.currentContentHash;
    let cancelled = false;
    let isRefreshing = false;
    let settledRefreshTimeoutId: number | null = null;
    let shouldRefreshAgain = false;

    async function refreshDocumentIfChanged() {
      if (cancelled) {
        return;
      }

      if (isRefreshing) {
        shouldRefreshAgain = true;
        return;
      }

      isRefreshing = true;

      try {
        const changedDocument = await invokeBackend<DocumentPayload | null>("check_document_update", {
          knownContentHash,
          relativePath: activeRelativePath,
          workspaceRoot,
        });

        if (cancelled || !changedDocument) {
          return;
        }

        if (changedDocument.relativePath !== activeRelativePath) {
          return;
        }

        if (pendingExternalDocument?.currentContentHash === changedDocument.currentContentHash) {
          if (!isDirty) {
            applyDocumentPayload(pendingExternalDocument);
          }
          return;
        }

        if (isDirty) {
          setPendingExternalDocument(changedDocument);
          return;
        }

        applyDocumentPayload(changedDocument);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(getErrorMessage(error, "Unable to check for external file changes."));
        }
      } finally {
        isRefreshing = false;

        if (!cancelled && shouldRefreshAgain) {
          shouldRefreshAgain = false;
          void refreshDocumentIfChanged();
        }
      }
    }

    let stopWatching: (() => void) | null = null;
    const watchTarget = getScopedWatchTarget(getParentDirectoryPath(activeAbsolutePath), {
      delayMs: 250,
    });
    const scheduleSettledRefresh = () => {
      if (settledRefreshTimeoutId !== null) {
        window.clearTimeout(settledRefreshTimeoutId);
      }

      settledRefreshTimeoutId = window.setTimeout(() => {
        settledRefreshTimeoutId = null;

        if (cancelled || isSaving) {
          return;
        }

        void refreshDocumentIfChanged();
      }, SETTLED_DOCUMENT_REFRESH_DELAY_MS);
    };

    void refreshDocumentIfChanged();
    void watchBackend(
      watchTarget.path,
      () => {
        if (cancelled || isSaving) {
          return;
        }

        void refreshDocumentIfChanged();
        scheduleSettledRefresh();
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
          setErrorMessage(getErrorMessage(error, "Unable to watch the active document."));
        }
      });

    return () => {
      cancelled = true;
      if (settledRefreshTimeoutId !== null) {
        window.clearTimeout(settledRefreshTimeoutId);
      }
      stopWatching?.();
    };
  }, [
    activeDocument?.absolutePath,
    activeDocument?.currentContentHash,
    activeDocument?.relativePath,
    isDirty,
    isSaving,
    pendingExternalDocument?.currentContentHash,
    setErrorMessage,
    setPendingExternalDocument,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!workspaceRoot) {
      return;
    }

    let cancelled = false;
    let isRefreshing = false;
    let shouldRefreshAgain = false;
    let refreshTimeoutId: number | null = null;
    let stopWatching: (() => void) | null = null;
    const watchTarget = getScopedWatchTarget(workspaceRoot, {
      delayMs: 200,
      recursive: true,
    });
    const workspaceWatchRoots = [workspaceRoot, watchTarget.path];

    async function refreshWorkspace() {
      if (cancelled) {
        return;
      }

      if (isRefreshing) {
        shouldRefreshAgain = true;
        return;
      }

      isRefreshing = true;

      try {
        await refreshWorkspaceFiles();
      } finally {
        isRefreshing = false;

        if (!cancelled && shouldRefreshAgain) {
          shouldRefreshAgain = false;
          scheduleRefresh();
        }
      }
    }

    function scheduleRefresh() {
      if (refreshTimeoutId !== null) {
        window.clearTimeout(refreshTimeoutId);
      }

      refreshTimeoutId = window.setTimeout(() => {
        refreshTimeoutId = null;
        void refreshWorkspace();
      }, WORKSPACE_REFRESH_DELAY_MS);
    }

    const refreshOnAppReturn = () => {
      const latest = useWorkspaceStore.getState();
      if (cancelled || latest.isSaving || latest.status === "loading") {
        return;
      }

      void refreshWorkspace();
    };

    void watchBackend(
      watchTarget.path,
      (event) => {
        const latest = useWorkspaceStore.getState();
        if (
          cancelled ||
          latest.isSaving ||
          latest.status === "loading" ||
          !shouldRefreshWorkspaceFromEvent(event, workspaceWatchRoots)
        ) {
          return;
        }

        scheduleRefresh();
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
          setErrorMessage(getErrorMessage(error, "Unable to watch workspace file changes."));
        }
      });

    window.addEventListener("focus", refreshOnAppReturn);
    document.addEventListener("visibilitychange", refreshOnVisibilityChange);

    return () => {
      cancelled = true;
      if (refreshTimeoutId !== null) {
        window.clearTimeout(refreshTimeoutId);
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
  }, [setErrorMessage, workspaceRoot]);
}

export function applyDocumentPayload(document: DocumentPayload) {
  const store = useWorkspaceStore.getState();
  store.setActiveDocument(document);

  if (!store.workspace) {
    return;
  }

  const hasExistingEntry = store.workspace.documents.some(
    (entry) => entry.relativePath === document.relativePath,
  );
  const nextDocuments = hasExistingEntry
    ? store.workspace.documents.map((entry) =>
        entry.relativePath === document.relativePath ? document : entry,
      )
    : [...store.workspace.documents, document];

  const nextWorkspace = {
    ...store.workspace,
    documents: nextDocuments,
    selectedRelativePath: document.relativePath,
  };

  store.setWorkspace(nextWorkspace);
  rememberRecentWorkspace(nextWorkspace, document.relativePath);
}

export function reloadPendingExternalDocument() {
  const pendingExternalDocument = useWorkspaceStore.getState().pendingExternalDocument;
  if (!pendingExternalDocument) {
    return;
  }

  applyDocumentPayload(pendingExternalDocument);
}

async function synchronizeWorkspaceSnapshot(
  nextWorkspace: WorkspaceSnapshot,
  preferredRelativePath: string | null,
  options: {
    requestToken?: number;
    reloadSelectedDocument?: boolean;
  } = {},
) {
  if (!isCurrentWorkspaceRequest(options.requestToken)) {
    return null;
  }

  const store = useWorkspaceStore.getState();
  const selectedRelativePath = resolveWorkspaceSelection(nextWorkspace, preferredRelativePath);
  const nextWorkspaceState = {
    ...nextWorkspace,
    selectedRelativePath,
  };

  if (shouldUpdateWorkspaceState(store.workspace, nextWorkspaceState)) {
    store.setWorkspace(nextWorkspaceState);
  }

  if (!isCurrentWorkspaceRequest(options.requestToken)) {
    return null;
  }

  const shouldReloadSelectedDocument =
    options.reloadSelectedDocument ||
    !store.activeDocument ||
    store.activeDocument.relativePath !== selectedRelativePath;

  if (!selectedRelativePath) {
    store.setActiveDocument(null);
    rememberRecentWorkspace(nextWorkspaceState, null);
    return null;
  }

  if (!shouldReloadSelectedDocument) {
    rememberRecentWorkspace(nextWorkspaceState, selectedRelativePath);
    return selectedRelativePath;
  }

  await loadDocument(selectedRelativePath, nextWorkspace.rootPath, {
    requestToken: options.requestToken,
  });

  if (!isCurrentWorkspaceRequest(options.requestToken)) {
    return null;
  }

  rememberRecentWorkspace(nextWorkspaceState, selectedRelativePath);
  return selectedRelativePath;
}

async function hydrateWorkspace(
  selection: string,
  options: {
    preferredRelativePath?: string | null;
    silentFailure?: boolean;
  } = {},
) {
  const requestToken = beginWorkspaceRequest();
  const store = useWorkspaceStore.getState();
  store.setErrorMessage(null);
  store.setStatus("loading");

  try {
    const workspace = await invokeBackend<WorkspaceSnapshot>("open_workspace", { path: selection });
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    await synchronizeWorkspaceSnapshot(
      workspace,
      options.preferredRelativePath ?? workspace.selectedRelativePath,
      {
        requestToken,
        reloadSelectedDocument: true,
      },
    );

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("ready");
  } catch (error) {
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    if (options.silentFailure) {
      store.setStatus("idle");
      store.setErrorMessage(null);
      const failedRoot = readRecentWorkspaces()[0]?.rootPath;
      if (failedRoot) {
        forgetRecentWorkspace(failedRoot);
      }
      return;
    }

    store.setStatus("error");
    store.setErrorMessage(getErrorMessage(error, "Unable to open the selected workspace."));
  }
}

export async function openWorkspacePath(
  selection: string,
  options: {
    preferredRelativePath?: string | null;
  } = {},
) {
  await hydrateWorkspace(selection, options);
}

async function applyWorkspaceOpenRequest(request: WorkspaceOpenRequest) {
  if (request.documentRelativePath && request.workspaceRoot) {
    await hydrateWorkspace(request.workspaceRoot, {
      preferredRelativePath: request.documentRelativePath,
    });
    return;
  }

  if (request.documentRelativePath && !isLikelyAbsolutePath(request.path)) {
    const workspace = useWorkspaceStore.getState().workspace;
    if (!workspace) {
      throw new Error("Open a Margent workspace before using document-relative deep links.");
    }

    await loadDocument(request.documentRelativePath, workspace.rootPath);
    return;
  }

  await hydrateWorkspace(request.path, {
    preferredRelativePath: request.documentRelativePath ?? undefined,
  });
}

export async function openFolderWorkspace() {
  const selection = await openBackend({
    directory: true,
    multiple: false,
    title: "Open Markdown Workspace",
  });

  if (typeof selection === "string") {
    await hydrateWorkspace(selection);
  }
}

export async function openFileWorkspace() {
  const selection = await openBackend({
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    multiple: false,
    title: "Open Markdown File",
  });

  if (typeof selection === "string") {
    await hydrateWorkspace(selection);
  }
}

export async function loadDocument(
  relativePath: string,
  rootPath = useWorkspaceStore.getState().workspace?.rootPath,
  options: {
    requestToken?: number;
  } = {},
) {
  if (!rootPath) {
    return;
  }

  const requestToken = options.requestToken ?? beginWorkspaceRequest();
  const store = useWorkspaceStore.getState();
  store.setErrorMessage(null);

  try {
    const document = await invokeBackend<DocumentPayload>("read_document", {
      relativePath,
      workspaceRoot: rootPath,
    });

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    applyDocumentPayload(document);
  } catch (error) {
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setErrorMessage(getErrorMessage(error, "Unable to read the selected document."));
  }
}

export async function refreshWorkspaceFiles() {
  const store = useWorkspaceStore.getState();
  const workspace = store.workspace;

  if (!workspace || store.status === "loading") {
    return;
  }

  const requestToken = beginWorkspaceRequest();
  store.setErrorMessage(null);
  store.setStatus("loading");

  try {
    const refreshedWorkspace = await loadWorkspaceSnapshot(
      workspace,
      store.activeDocument?.absolutePath ?? null,
    );
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    await synchronizeWorkspaceSnapshot(
      refreshedWorkspace,
      store.activeDocument?.relativePath ?? workspace.selectedRelativePath,
      {
        requestToken,
      },
    );

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("ready");
  } catch (error) {
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("error");
    store.setErrorMessage(getErrorMessage(error, "Unable to refresh workspace files."));
  }
}

export async function createMarkdownFile(relativePath: string, content = "") {
  const store = useWorkspaceStore.getState();
  const workspace = store.workspace;

  if (!workspace || store.status === "loading") {
    return;
  }

  const requestToken = beginWorkspaceRequest();
  store.setErrorMessage(null);
  store.setStatus("loading");

  try {
    const document = await invokeBackend<DocumentPayload>("create_markdown_file", {
      content,
      relativePath,
      workspaceRoot: workspace.rootPath,
    });

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    applyDocumentPayload(document);
    const refreshedWorkspace = await invokeBackend<WorkspaceSnapshot>("open_workspace", {
      path: document.absolutePath,
    });
    await synchronizeWorkspaceSnapshot(refreshedWorkspace, document.relativePath, {
      requestToken,
    });

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("ready");
  } catch (error) {
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("error");
    store.setErrorMessage(getErrorMessage(error, "Unable to create the Markdown file."));
  }
}

export async function renameMarkdownFile(fromRelativePath: string, toRelativePath: string) {
  const store = useWorkspaceStore.getState();
  const workspace = store.workspace;
  const activeDocument = store.activeDocument;
  const isActiveDocument = activeDocument?.relativePath === fromRelativePath;

  if (!workspace || store.status === "loading") {
    return;
  }

  if (isActiveDocument && store.isEditorDirty) {
    store.setErrorMessage("Save the active draft before renaming it.");
    return;
  }

  const requestToken = beginWorkspaceRequest();
  store.setErrorMessage(null);
  store.setStatus("loading");

  try {
    const renamedDocument = await invokeBackend<DocumentPayload>("rename_markdown_file", {
      fromRelativePath,
      toRelativePath,
      workspaceRoot: workspace.rootPath,
    });

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    const refreshedWorkspace = await invokeBackend<WorkspaceSnapshot>("open_workspace", {
      path: isActiveDocument ? renamedDocument.absolutePath : workspace.rootPath,
    });

    if (isActiveDocument) {
      applyDocumentPayload(renamedDocument);
    }

    await synchronizeWorkspaceSnapshot(
      refreshedWorkspace,
      isActiveDocument ? renamedDocument.relativePath : activeDocument?.relativePath ?? null,
      {
        requestToken,
      },
    );

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("ready");
  } catch (error) {
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("error");
    store.setErrorMessage(getErrorMessage(error, "Unable to rename the Markdown file."));
  }
}

export async function deleteMarkdownFile(relativePath: string) {
  const store = useWorkspaceStore.getState();
  const workspace = store.workspace;
  const activeDocument = store.activeDocument;
  const isActiveDocument = activeDocument?.relativePath === relativePath;

  if (!workspace || store.status === "loading") {
    return;
  }

  if (isActiveDocument && store.isEditorDirty) {
    store.setErrorMessage("Save the active draft before deleting it.");
    return;
  }

  const preferredRelativePath = getPostDeletePreferredRelativePath(
    workspace.documents.map((document) => document.relativePath),
    relativePath,
    activeDocument?.relativePath ?? null,
  );
  const requestToken = beginWorkspaceRequest();
  store.setErrorMessage(null);
  store.setStatus("loading");

  try {
    const refreshedWorkspace = await invokeBackend<WorkspaceSnapshot>("delete_markdown_file", {
      relativePath,
      workspaceRoot: workspace.rootPath,
    });

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    await synchronizeWorkspaceSnapshot(refreshedWorkspace, preferredRelativePath, {
      requestToken,
      reloadSelectedDocument: isActiveDocument,
    });

    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("ready");
  } catch (error) {
    if (!isCurrentWorkspaceRequest(requestToken)) {
      return;
    }

    store.setStatus("error");
    store.setErrorMessage(getErrorMessage(error, "Unable to delete the Markdown file."));
  }
}

export async function revealMarkdownFile(relativePath: string) {
  const store = useWorkspaceStore.getState();
  const workspace = store.workspace;

  if (!workspace) {
    return;
  }

  store.setErrorMessage(null);

  try {
    await invokeBackend("reveal_markdown_file", {
      relativePath,
      workspaceRoot: workspace.rootPath,
    });
  } catch (error) {
    store.setErrorMessage(getErrorMessage(error, "Unable to reveal the Markdown file."));
  }
}

export async function importWorkspaceAsset(suggestedName: string, bytes: number[]) {
  const store = useWorkspaceStore.getState();
  const workspace = store.workspace;

  if (!workspace) {
    throw new Error("Open a Margent workspace before importing image assets.");
  }

  store.setErrorMessage(null);

  try {
    return await invokeBackend<AssetImportResult>("import_asset", {
      bytes,
      suggestedName,
      workspaceRoot: workspace.rootPath,
    });
  } catch (error) {
    const message = getErrorMessage(error, "Unable to import the image asset.");
    store.setErrorMessage(message);
    throw new Error(message);
  }
}

export async function saveCurrentDocument(content: string) {
  const latest = useWorkspaceStore.getState();

  if (!latest.workspace || !latest.activeDocument || latest.isSaving) {
    return;
  }

  const { activeDocument, workspace } = latest;
  if (!latest.isEditorDirty && content === activeDocument.content) {
    return;
  }

  latest.setIsSaving(true);
  latest.setErrorMessage(null);

  try {
    const document = await measurePerfAsync(
      "saveCurrentDocument",
      () =>
        invokeBackend<DocumentPayload>("save_document", {
          content,
          relativePath: activeDocument.relativePath,
          workspaceRoot: workspace.rootPath,
        }),
      {
        contentLength: content.length,
      },
    );
    applyDocumentPayload(document);
  } catch (error) {
    latest.setErrorMessage(getErrorMessage(error, "Unable to save the active document."));
  } finally {
    latest.setIsSaving(false);
  }
}

function getPostDeletePreferredRelativePath(
  relativePaths: string[],
  deletedRelativePath: string,
  currentRelativePath: string | null,
) {
  if (currentRelativePath && currentRelativePath !== deletedRelativePath) {
    return currentRelativePath;
  }

  const deletedIndex = relativePaths.indexOf(deletedRelativePath);
  const remainingPaths = relativePaths.filter((relativePath) => relativePath !== deletedRelativePath);

  if (!remainingPaths.length) {
    return null;
  }

  if (deletedIndex >= 0 && deletedIndex < remainingPaths.length) {
    return remainingPaths[deletedIndex];
  }

  return remainingPaths[remainingPaths.length - 1];
}

async function loadWorkspaceSnapshot(
  workspace: WorkspaceSnapshot,
  preferredPath: string | null = null,
) {
  if (preferredPath) {
    try {
      return await invokeBackend<WorkspaceSnapshot>("open_workspace", {
        path: preferredPath,
      });
    } catch {
      // Fall back to the existing workspace-opened path or root if the current file moved.
    }
  }

  if (workspace.openedPath) {
    try {
      return await invokeBackend<WorkspaceSnapshot>("open_workspace", {
        path: workspace.openedPath,
      });
    } catch {
      // Fall back to the workspace root when the originally opened file no longer exists.
    }
  }

  return invokeBackend<WorkspaceSnapshot>("open_workspace", {
    path: workspace.rootPath,
  });
}

function resolveWorkspaceSelection(
  workspace: WorkspaceSnapshot,
  preferredRelativePath: string | null,
) {
  if (
    preferredRelativePath &&
    workspace.documents.some((document) => document.relativePath === preferredRelativePath)
  ) {
    return preferredRelativePath;
  }

  return workspace.selectedRelativePath ?? workspace.documents[0]?.relativePath ?? null;
}

function shouldUpdateWorkspaceState(
  currentWorkspace: WorkspaceSnapshot | null,
  nextWorkspace: WorkspaceSnapshot,
) {
  if (!currentWorkspace) {
    return true;
  }

  if (
    currentWorkspace.rootPath !== nextWorkspace.rootPath ||
    currentWorkspace.openedPath !== nextWorkspace.openedPath ||
    currentWorkspace.mdreviewPath !== nextWorkspace.mdreviewPath ||
    currentWorkspace.selectedRelativePath !== nextWorkspace.selectedRelativePath ||
    currentWorkspace.documents.length !== nextWorkspace.documents.length
  ) {
    return true;
  }

  return currentWorkspace.documents.some(
    (document, index) =>
      document.relativePath !== nextWorkspace.documents[index]?.relativePath ||
      document.displayName !== nextWorkspace.documents[index]?.displayName,
  );
}

function shouldRefreshWorkspaceFromEvent(event: WatchEvent, workspaceRoots: string[]) {
  const relevantPaths = event.paths
    .map(normalizeWorkspacePath)
    .filter((path) => !pathIncludesExcludedWorkspaceDirectory(path, workspaceRoots));

  if (!relevantPaths.length) {
    return false;
  }

  if (relevantPaths.some(isMarkdownPath)) {
    return isWorkspaceStructuralEvent(event.type);
  }

  if (isRenameEvent(event.type)) {
    return true;
  }

  return isDirectoryStructureEvent(event.type);
}

function isWorkspaceStructuralEvent(eventType: WatchEvent["type"]) {
  if (eventType === "any" || eventType === "other") {
    return true;
  }

  if (typeof eventType !== "object" || "access" in eventType) {
    return false;
  }

  if ("create" in eventType || "remove" in eventType) {
    return true;
  }

  return "modify" in eventType && ["any", "rename", "other"].includes(eventType.modify.kind);
}

function isDirectoryStructureEvent(eventType: WatchEvent["type"]) {
  if (eventType === "any" || eventType === "other") {
    return true;
  }

  if (typeof eventType !== "object" || "access" in eventType || "modify" in eventType) {
    return false;
  }

  if ("create" in eventType) {
    return ["any", "folder", "other"].includes(eventType.create.kind);
  }

  return "remove" in eventType && ["any", "folder", "other"].includes(eventType.remove.kind);
}

function isRenameEvent(eventType: WatchEvent["type"]) {
  return typeof eventType === "object" && "modify" in eventType
    ? ["any", "rename", "other"].includes(eventType.modify.kind)
    : false;
}

function isMarkdownPath(path: string) {
  return /\.(md|markdown)$/i.test(path);
}

function pathIncludesExcludedWorkspaceDirectory(path: string, workspaceRoots: string[]) {
  for (const workspaceRoot of workspaceRoots) {
    const normalizedRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedRoot || !path.startsWith(normalizedRoot)) {
      continue;
    }

    const relativePath = path.slice(normalizedRoot.length).replace(/^\/+/, "");
    if (!relativePath) {
      return false;
    }

    return relativePath
      .split("/")
      .some((segment) => WORKSPACE_EXCLUDED_DIRECTORIES.has(segment));
  }

  return false;
}

function normalizeWorkspacePath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function selectThreadWhenAvailable(threadId: string) {
  useThreadStore.getState().selectThread(threadId);

  let attempts = 0;
  const retry = () => {
    attempts += 1;
    const store = useThreadStore.getState();
    if (store.threads.some((thread) => thread.id === threadId) || attempts >= 20) {
      store.selectThread(threadId);
      return;
    }

    window.setTimeout(retry, 100);
  };

  window.setTimeout(retry, 100);
}

function isLikelyAbsolutePath(path: string) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
