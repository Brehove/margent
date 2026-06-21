import "./App.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CommandPalette,
  type CommandPaletteCommand,
  type CommandPaletteMode,
} from "./components/command/CommandPalette";
import { DocumentEditor } from "./components/editor/DocumentEditor";
import { FileBrowser, type FileActionRequest } from "./components/files/FileBrowser";
import { ProviderSetupView } from "./components/providers/ProviderSetupView";
import { ReviewBriefView } from "./components/review/ReviewBriefView";
import { ProjectSearchView } from "./components/search/ProjectSearchView";
import {
  APP_MENU_COMMAND_EVENT,
  APP_MENU_COMMANDS,
  dispatchEditorMenuCommand,
  isAppMenuCommand,
  type AppMenuCommand,
} from "./lib/appMenuCommands";
import { getErrorMessage } from "./lib/errorMessage";
import { invokeBackend, isDesktopBackend, listenBackend } from "./lib/backend";
import { useProposals } from "./hooks/useProposals";
import { useReviewBrief } from "./hooks/useReviewBrief";
import { useReviewData } from "./hooks/useReviewData";
import { useThreads } from "./hooks/useThreads";
import {
  createMarkdownFile,
  deleteMarkdownFile,
  keepMargentVersionForSaveConflict,
  loadDocument,
  importWorkspaceAsset,
  openFileWorkspace,
  openFolderWorkspace,
  openWorkspacePath,
  renameMarkdownFile,
  refreshWorkspaceFiles,
  revealMarkdownFile,
  reloadSaveConflictDiskVersion,
  revertLatestSnapshotForActiveDocument,
  saveCurrentDocument,
  useWorkspaceEffects,
} from "./hooks/useWorkspace";
import { useUiStore } from "./stores/uiStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { readRecentWorkspaces } from "./lib/recentWorkspaces";
import type { DocumentExportFormat, DocumentExportResult } from "./types/export";
import type { ProposalRecord } from "./types/proposal";
import type { ProviderReadiness } from "./types/providerReadiness";
import type { ReviewPassSummary } from "./types/reviewPass";
import type { ProjectSearchResult } from "./types/search";
import type { EditorSelectionSnapshot, ThreadRecord } from "./types/thread";
import type { DocumentPayload, SaveConflict } from "./types/workspace";

type AgentProviderId = "codex" | "claude";
type AppView = "editor" | "project-search" | "providers" | "review-brief";
type ProviderThreadActionKind = "feedback" | "revise";
type ProviderDocumentActionKind = "feedback" | "revise";
const PROVIDER_STREAM_EVENT = "margent://provider-stream";

function safeUnlisten(unlisten: () => void | Promise<void>) {
  try {
    const result = unlisten();
    if (result && typeof result.then === "function") {
      void result.catch(() => {});
    }
  } catch {
    // Tauri dev can race listener cleanup during hot reload.
  }
}

interface EditorNavigationRequest {
  id: number;
  line: number;
  relativePath: string;
}

interface ProviderThreadActionResult {
  thread: ThreadRecord;
  proposal: ProposalRecord | null;
}

interface ProviderStreamEvent {
  runId: string;
  provider: AgentProviderId;
  phase: "delta" | "cancelled" | "error";
  text?: string | null;
  message?: string | null;
}

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

function App() {
  const activeDocument = useWorkspaceStore((state) => state.activeDocument);
  const errorMessage = useWorkspaceStore((state) => state.errorMessage);
  const isEditorDirty = useWorkspaceStore((state) => state.isEditorDirty);
  const isSaving = useWorkspaceStore((state) => state.isSaving);
  const isFocusModeEnabled = useUiStore((state) => state.isFocusModeEnabled);
  const isWorkspacePaneCollapsed = useUiStore((state) => state.isWorkspacePaneCollapsed);
  const preferredReviewPassName = useUiStore((state) => state.preferredReviewPassName);
  const saveConflict = useWorkspaceStore((state) => state.saveConflict);
  const setActiveDocument = useWorkspaceStore((state) => state.setActiveDocument);
  const setPreferredReviewPassName = useUiStore((state) => state.setPreferredReviewPassName);
  const setWorkspaceErrorMessage = useWorkspaceStore((state) => state.setErrorMessage);
  const status = useWorkspaceStore((state) => state.status);
  const toggleWorkspacePane = useUiStore((state) => state.toggleWorkspacePane);
  const toggleFocusMode = useUiStore((state) => state.toggleFocusMode);
  const themeMode = useUiStore((state) => state.themeMode);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const workspaceLabel = workspace ? getLastPathSegment(workspace.rootPath) : null;
  const topbarContext = workspaceLabel ? `${workspaceLabel} workspace` : "Rendered-first markdown review";
  const recentWorkspaces = readRecentWorkspaces();
  const [appView, setAppView] = useState<AppView>("editor");
  const [editorNavigationRequest, setEditorNavigationRequest] =
    useState<EditorNavigationRequest | null>(null);
  const [exportStatusMessage, setExportStatusMessage] = useState<string | null>(null);
  const [fileActionRequest, setFileActionRequest] = useState<FileActionRequest | null>(null);
  const [isFocusChromeDimmed, setIsFocusChromeDimmed] = useState(false);
  const [isRecentMenuOpen, setIsRecentMenuOpen] = useState(false);
  const [isProviderReadinessLoading, setIsProviderReadinessLoading] = useState(false);
  const [isSaveConflictCompareOpen, setIsSaveConflictCompareOpen] = useState(false);
  const [providerReadiness, setProviderReadiness] = useState<ProviderReadiness[]>([]);
  const [providerReadinessError, setProviderReadinessError] = useState<string | null>(null);
  const [reviewPasses, setReviewPasses] = useState<ReviewPassSummary[]>([]);
  const focusChromeFadeTimeoutRef = useRef<number | null>(null);
  const reviewDataState = useReviewData({
    activeDocument,
    workspace,
  });
  const threadState = useThreads({
    activeDocument,
    workspace,
  });
  const {
    selectThread,
    upsertThread,
  } = threadState;
  const proposalState = useProposals({
    activeDocument,
    onDocumentApplied: setActiveDocument,
    workspace,
  });
  const { upsertProposal } = proposalState;
  const reviewBriefState = useReviewBrief({
    activeDocument,
    onActiveDocumentApplied: setActiveDocument,
    onActiveThreadUpdated: upsertThread,
    onRefreshReviewData: reviewDataState.loadReviewData,
    workspace,
  });
  const [providerActionState, setProviderActionState] = useState<ProviderActionState>({
    action: null,
    errorMessage: null,
    provider: null,
    runId: null,
    streamedText: "",
    threadId: null,
  });
  const cancelledProviderRunsRef = useRef<Set<string>>(new Set());
  const providerStreamBufferRef = useRef<Map<string, string>>(new Map());
  const providerStreamFrameRef = useRef<number | null>(null);
  const [commandPaletteMode, setCommandPaletteMode] = useState<CommandPaletteMode | null>(null);
  const [providerDocumentActionState, setProviderDocumentActionState] =
    useState<ProviderDocumentActionState>({
      action: null,
      documentId: null,
      errorMessage: null,
      provider: null,
      runId: null,
      streamedText: "",
    });

  const handleEditorSave = useCallback((content: string) => {
    void saveCurrentDocument(content);
  }, []);

  const loadProviderReadiness = useCallback(async () => {
    if (!isDesktopBackend()) {
      setProviderReadiness([]);
      setProviderReadinessError("Provider setup checks are available in the desktop app.");
      return;
    }

    setIsProviderReadinessLoading(true);
    setProviderReadinessError(null);
    try {
      const readiness = await invokeBackend<ProviderReadiness[]>("get_provider_readiness");
      setProviderReadiness(readiness);
    } catch (error) {
      setProviderReadinessError(
        getErrorMessage(error, "Unable to check provider setup."),
      );
    } finally {
      setIsProviderReadinessLoading(false);
    }
  }, []);

  const readyProviderIds = useMemo(
    () => new Set(providerReadiness.filter((provider) => provider.ready).map((provider) => provider.id)),
    [providerReadiness],
  );

  const hasReadyProvider = readyProviderIds.size > 0;

  useEffect(() => {
    const root = document.documentElement;
    if (themeMode === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.dataset.theme = themeMode;
    }

    return () => {
      root.removeAttribute("data-theme");
    };
  }, [themeMode]);

  useEffect(() => {
    if (!saveConflict) {
      setIsSaveConflictCompareOpen(false);
    }
  }, [saveConflict]);

  useEffect(() => {
    void loadProviderReadiness();
  }, [loadProviderReadiness]);

  useEffect(() => {
    let isCancelled = false;

    if (!workspace) {
      setReviewPasses([]);
      return () => {
        isCancelled = true;
      };
    }

    invokeBackend<ReviewPassSummary[]>("list_review_passes", {
      workspaceRoot: workspace.rootPath,
    })
      .then((passes) => {
        if (isCancelled) {
          return;
        }
        setReviewPasses(passes);
        if (
          preferredReviewPassName &&
          !passes.some((reviewPass) => reviewPass.name === preferredReviewPassName)
        ) {
          setPreferredReviewPassName(null);
        }
      })
      .catch(() => {
        if (isCancelled) {
          return;
        }
        setReviewPasses([]);
        if (preferredReviewPassName) {
          setPreferredReviewPassName(null);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [preferredReviewPassName, setPreferredReviewPassName, workspace]);
  const activeProviderActivity = useMemo(() => {
    const runningThreadProvider =
      providerActionState.action && providerActionState.provider
        ? {
            action: providerActionState.action,
            provider: providerActionState.provider,
          }
        : null;
    const runningDocumentProvider =
      providerDocumentActionState.action && providerDocumentActionState.provider
        ? {
            action: providerDocumentActionState.action,
            provider: providerDocumentActionState.provider,
          }
        : null;
    const activity = runningThreadProvider ?? runningDocumentProvider;

    if (!activity) {
      return null;
    }

    return {
      actionLabel: activity.action === "revise" ? "Writing" : "Reading",
      providerLabel: formatProviderName(activity.provider),
    };
  }, [
    providerActionState.action,
    providerActionState.provider,
    providerDocumentActionState.action,
    providerDocumentActionState.provider,
  ]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const isPaletteShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "p";
      const isProjectSearchShortcut =
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f";
      if (!isPaletteShortcut && !isProjectSearchShortcut) {
        return;
      }

      event.preventDefault();
      if (isProjectSearchShortcut) {
        if (activeDocument && isEditorEventTarget(event.target)) {
          toggleFocusMode();
          return;
        }

        if (workspace) {
          setAppView("project-search");
        }
        return;
      }

      setCommandPaletteMode(event.shiftKey ? "commands" : "files");
    };

    window.addEventListener("keydown", handleKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleKeydown, true);
    };
  }, [activeDocument, toggleFocusMode, workspace]);

  const handleFocusModeTypingActivity = useCallback(() => {
    if (!useUiStore.getState().isFocusModeEnabled) {
      return;
    }

    setIsFocusChromeDimmed(false);
    if (focusChromeFadeTimeoutRef.current !== null) {
      window.clearTimeout(focusChromeFadeTimeoutRef.current);
    }

    focusChromeFadeTimeoutRef.current = window.setTimeout(() => {
      focusChromeFadeTimeoutRef.current = null;
      if (useUiStore.getState().isFocusModeEnabled) {
        setIsFocusChromeDimmed(true);
      }
    }, 2000);
  }, []);

  useEffect(() => {
    if (!isFocusModeEnabled) {
      setIsFocusChromeDimmed(false);
      if (focusChromeFadeTimeoutRef.current !== null) {
        window.clearTimeout(focusChromeFadeTimeoutRef.current);
        focusChromeFadeTimeoutRef.current = null;
      }
      return;
    }

    const restoreChrome = () => {
      setIsFocusChromeDimmed(false);
    };

    window.addEventListener("pointermove", restoreChrome, { passive: true });
    window.addEventListener("keydown", restoreChrome, true);
    return () => {
      window.removeEventListener("pointermove", restoreChrome);
      window.removeEventListener("keydown", restoreChrome, true);
      if (focusChromeFadeTimeoutRef.current !== null) {
        window.clearTimeout(focusChromeFadeTimeoutRef.current);
        focusChromeFadeTimeoutRef.current = null;
      }
    };
  }, [isFocusModeEnabled]);

  const paletteCommands = useMemo<CommandPaletteCommand[]>(
    () => [
      {
        detail: workspace ? workspace.rootPath : "Open a workspace first",
        disabled: !workspace,
        id: "new-file",
        label: "New Markdown File",
        keywords: ["create", "document"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "rename-active-file",
        label: "Rename Active File",
        keywords: ["move", "document"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "reveal-active-file",
        label: "Reveal Active File",
        keywords: ["finder", "show"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "delete-active-file",
        label: "Delete Active File",
        keywords: ["remove", "document"],
      },
      {
        detail: activeDocument
          ? isEditorDirty
            ? "Save the draft before reverting"
            : activeDocument.relativePath
          : "Open a document first",
        disabled: !activeDocument || isEditorDirty,
        id: "revert-last-snapshot",
        label: "Revert Last Snapshot",
        keywords: ["restore", "snapshot", "undo", "rollback"],
      },
      {
        id: "open-file",
        label: "Open File...",
        keywords: ["markdown", "document"],
      },
      {
        id: "open-folder",
        label: "Open Folder...",
        keywords: ["workspace", "directory"],
      },
      ...recentWorkspaces.map((recent, index) => ({
        detail: recent.activeRelativePath ?? recent.rootPath,
        id: `open-recent:${index}`,
        label: `Open Recent: ${recent.label}`,
        keywords: ["recent", "history", "reopen"],
      })),
      {
        detail: workspace ? workspace.rootPath : "Open a workspace first",
        disabled: !workspace,
        id: "refresh-files",
        label: "Refresh Files",
        keywords: ["reload", "documents"],
      },
      {
        detail: workspace ? workspace.rootPath : "Open a workspace first",
        disabled: !workspace,
        id: "project-search",
        label: "Project Search",
        keywords: ["find", "grep", "regex", "workspace"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "export-html",
        label: "Export HTML",
        keywords: ["publish", "canvas", "pressbooks"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "export-docx",
        label: "Export DOCX",
        keywords: ["word", "download"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "export-gdoc",
        label: "Export to Google Docs",
        keywords: ["google", "drive", "docs"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "export-pdf",
        label: "Print / Save as PDF",
        keywords: ["pdf", "print"],
      },
      {
        detail: workspace ? workspace.rootPath : "Open a workspace first",
        disabled: !workspace,
        id: "review-brief",
        label: "Review Brief",
        keywords: ["queue", "proposals", "agent"],
      },
      {
        detail: hasReadyProvider ? "Provider ready" : "Install or log in to Codex / Claude Code",
        id: "providers",
        label: "Providers",
        keywords: ["agent", "codex", "claude", "setup", "doctor"],
      },
      {
        detail: activeDocument?.relativePath ?? "Open a document first",
        disabled: !activeDocument,
        id: "editor-view",
        label: "Back to Editor",
        keywords: ["document", "write"],
      },
      {
        detail: workspace ? workspace.rootPath : "Open a workspace first",
        disabled: !workspace,
        id: "toggle-files",
        label: isWorkspacePaneCollapsed ? "Show File Pane" : "Hide File Pane",
        keywords: ["sidebar", "workspace"],
      },
      {
        disabled: !workspace,
        id: "mode-rendered",
        label: "Rendered Mode",
        keywords: ["preview", "editor"],
      },
      {
        disabled: !workspace,
        id: "mode-raw",
        label: "Raw Mode",
        keywords: ["source", "editor"],
      },
      {
        detail: activeDocument ? "Cmd+Shift+F in the editor" : "Open a document first",
        disabled: !activeDocument,
        id: "toggle-focus-mode",
        label: isFocusModeEnabled ? "Turn Off Focus Mode" : "Focus Mode",
        keywords: ["typewriter", "drafting", "zen"],
      },
      {
        detail: themeMode === "system" ? "Active" : "Use default ledger theme",
        id: "theme-system",
        label: "Theme: Default",
        keywords: ["appearance", "dark", "light"],
      },
      {
        detail: themeMode === "light" ? "Active" : "Use light paper theme",
        id: "theme-light",
        label: "Theme: Light",
        keywords: ["appearance", "paper"],
      },
      {
        detail: themeMode === "dark" ? "Active" : "Use dark lamplight theme",
        id: "theme-dark",
        label: "Theme: Dark",
        keywords: ["appearance", "night", "lamplight"],
      },
      {
        detail: isDesktopBackend() ? "GitHub Releases" : "Desktop app only",
        disabled: !isDesktopBackend(),
        id: "check-for-updates",
        label: "Check for Updates",
        keywords: ["release", "upgrade"],
      },
      {
        disabled: !activeDocument,
        id: "find",
        label: "Find in Document",
        keywords: ["search"],
      },
      {
        disabled: !activeDocument || !isEditorDirty,
        id: "save",
        label: "Save Draft",
        keywords: ["write"],
      },
    ],
    [
      activeDocument,
      isEditorDirty,
      isFocusModeEnabled,
      isWorkspacePaneCollapsed,
      hasReadyProvider,
      recentWorkspaces,
      themeMode,
      workspace,
    ],
  );

  const requestFileAction = useCallback(
    (kind: FileActionRequest["kind"], relativePath?: string | null) => {
      if (isWorkspacePaneCollapsed) {
        useUiStore.getState().setWorkspacePaneCollapsed(false);
      }

      setFileActionRequest({
        id: Date.now(),
        kind,
        relativePath: relativePath ?? null,
      });
    },
    [isWorkspacePaneCollapsed],
  );

  const openRecentWorkspace = useCallback(
    async (index: number) => {
      const recent = readRecentWorkspaces()[index];
      if (!recent) {
        return;
      }

      setIsRecentMenuOpen(false);
      setAppView("editor");
      await openWorkspacePath(recent.openedPath ?? recent.rootPath, {
        preferredRelativePath: recent.activeRelativePath,
      });
    },
    [],
  );

  const runDocumentExport = useCallback(
    async (format: DocumentExportFormat, googleDoc = false) => {
      if (!workspace || !activeDocument) {
        return;
      }

      if (isEditorDirty) {
        setWorkspaceErrorMessage("Save the draft before exporting.");
        return;
      }

      setWorkspaceErrorMessage(null);
      setExportStatusMessage(null);

      try {
        const result = await invokeBackend<DocumentExportResult>("export_document", {
          format,
          googleDoc,
          relativePath: activeDocument.relativePath,
          workspaceRoot: workspace.rootPath,
        });

        if (result.googleDocUrl) {
          setExportStatusMessage(`Exported ${result.documentRelativePath} to Google Docs: ${result.googleDocUrl}`);
        } else if (result.outputPath) {
          setExportStatusMessage(`Exported ${result.documentRelativePath} to ${result.outputPath}`);
        } else {
          setExportStatusMessage(`Exported ${result.documentRelativePath}.`);
        }
      } catch (error) {
        setWorkspaceErrorMessage(getErrorMessage(error, "Unable to export this document."));
      }
    },
    [activeDocument, isEditorDirty, setWorkspaceErrorMessage, workspace],
  );

  const runPdfExport = useCallback(() => {
    if (!activeDocument) {
      return;
    }

    setWorkspaceErrorMessage(null);
    setExportStatusMessage("Use the print dialog to save this document as PDF.");
    window.print();
  }, [activeDocument, setWorkspaceErrorMessage]);

  const openExternalUrl = useCallback((url: string) => {
    if (isDesktopBackend()) {
      void invokeBackend("open_external_url", { url });
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (!isDesktopBackend()) {
      return;
    }

    setWorkspaceErrorMessage(null);
    setExportStatusMessage("Checking for updates...");

    try {
      const [{ check }, { ask, message }] = await Promise.all([
        import("@tauri-apps/plugin-updater"),
        import("@tauri-apps/plugin-dialog"),
      ]);
      const update = await check();

      if (!update) {
        setExportStatusMessage("Margent is up to date.");
        return;
      }

      const shouldInstall = await ask(
        `Margent ${update.version} is available. Download and install it now?`,
        {
          cancelLabel: "Later",
          kind: "info",
          okLabel: "Install Update",
          title: "Update Margent",
        },
      );

      if (!shouldInstall) {
        setExportStatusMessage(`Margent ${update.version} is available.`);
        return;
      }

      let downloadedBytes = 0;
      setExportStatusMessage(`Downloading Margent ${update.version}...`);
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          downloadedBytes = 0;
          setExportStatusMessage(`Downloading Margent ${update.version}...`);
          return;
        }
        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const downloadedMb = (downloadedBytes / 1_000_000).toFixed(1);
          setExportStatusMessage(`Downloading Margent ${update.version}: ${downloadedMb} MB`);
          return;
        }
        if (event.event === "Finished") {
          setExportStatusMessage(`Installing Margent ${update.version}...`);
        }
      });
      await update.close().catch(() => undefined);
      setExportStatusMessage(`Installed Margent ${update.version}. Restart Margent to finish.`);
      await message("The update was installed. Quit and reopen Margent to finish.", {
        kind: "info",
        title: "Update Installed",
      });
    } catch (error) {
      setExportStatusMessage(null);
      setWorkspaceErrorMessage(getErrorMessage(error, "Unable to check for updates."));
    }
  }, [setWorkspaceErrorMessage]);

  const handlePaletteCommand = useCallback((commandId: string) => {
    if (commandId.startsWith("open-recent:")) {
      const index = Number.parseInt(commandId.slice("open-recent:".length), 10);
      if (Number.isInteger(index)) {
        void openRecentWorkspace(index);
      }
      return;
    }

    switch (commandId) {
      case "check-for-updates":
        void checkForUpdates();
        break;
      case "editor-view":
        setAppView("editor");
        break;
      case "delete-active-file":
        if (activeDocument) {
          requestFileAction("delete", activeDocument.relativePath);
        }
        break;
      case "find":
        dispatchEditorMenuCommand(APP_MENU_COMMANDS.find);
        break;
      case "export-docx":
        void runDocumentExport("docx");
        break;
      case "export-gdoc":
        // HTML is the preferred Drive-conversion intermediate: Google renders
        // its tables with native borders and no heading bookmark anchors, and
        // local images are inlined as data URIs so they survive conversion.
        // (DOCX via pandoc produces borderless table styling + bookmark
        // ribbons on headings; it remains available as an explicit format.)
        void runDocumentExport("html", true);
        break;
      case "export-html":
        void runDocumentExport("html");
        break;
      case "export-pdf":
        runPdfExport();
        break;
      case "mode-raw":
        useUiStore.getState().setEditorMode("raw");
        break;
      case "mode-rendered":
        useUiStore.getState().setEditorMode("rendered");
        break;
      case "toggle-focus-mode":
        useUiStore.getState().toggleFocusMode();
        break;
      case "theme-dark":
        useUiStore.getState().setThemeMode("dark");
        break;
      case "theme-light":
        useUiStore.getState().setThemeMode("light");
        break;
      case "theme-system":
        useUiStore.getState().setThemeMode("system");
        break;
      case "new-file": {
        requestFileAction("create");
        break;
      }
      case "open-file":
        void openFileWorkspace();
        break;
      case "open-folder":
        void openFolderWorkspace();
        break;
      case "project-search":
        setAppView("project-search");
        break;
      case "providers":
        setAppView("providers");
        void loadProviderReadiness();
        break;
      case "refresh-files":
        void refreshWorkspaceFiles();
        break;
      case "review-brief":
        setAppView("review-brief");
        break;
      case "rename-active-file": {
        if (!activeDocument) {
          break;
        }
        requestFileAction("rename", activeDocument.relativePath);
        break;
      }
      case "reveal-active-file":
        if (activeDocument) {
          void revealMarkdownFile(activeDocument.relativePath);
        }
        break;
      case "revert-last-snapshot":
        void revertLatestSnapshotForActiveDocument();
        break;
      case "save":
        dispatchEditorMenuCommand(APP_MENU_COMMANDS.save);
        break;
      case "toggle-files":
        useUiStore.getState().toggleWorkspacePane();
        break;
    }
  }, [
    activeDocument,
    checkForUpdates,
    loadProviderReadiness,
    openRecentWorkspace,
    requestFileAction,
    runDocumentExport,
    runPdfExport,
  ]);

  const handleAppMenuCommand = useCallback(
    (command: AppMenuCommand) => {
      switch (command) {
        case APP_MENU_COMMANDS.checkForUpdates:
          void checkForUpdates();
          break;
        case APP_MENU_COMMANDS.commandPalette:
          setCommandPaletteMode("commands");
          break;
        case APP_MENU_COMMANDS.deleteActiveFile:
          handlePaletteCommand("delete-active-file");
          break;
        case APP_MENU_COMMANDS.exportDocx:
          handlePaletteCommand("export-docx");
          break;
        case APP_MENU_COMMANDS.exportGdoc:
          handlePaletteCommand("export-gdoc");
          break;
        case APP_MENU_COMMANDS.exportHtml:
          handlePaletteCommand("export-html");
          break;
        case APP_MENU_COMMANDS.exportPdf:
          handlePaletteCommand("export-pdf");
          break;
        case APP_MENU_COMMANDS.newFile:
          handlePaletteCommand("new-file");
          break;
        case APP_MENU_COMMANDS.openFile:
          void openFileWorkspace();
          break;
        case APP_MENU_COMMANDS.openRecent:
          setIsRecentMenuOpen(true);
          break;
        case APP_MENU_COMMANDS.projectSearch:
          handlePaletteCommand("project-search");
          break;
        case APP_MENU_COMMANDS.providers:
          handlePaletteCommand("providers");
          break;
        case APP_MENU_COMMANDS.quickOpen:
          setCommandPaletteMode("files");
          break;
        case APP_MENU_COMMANDS.rawMode:
          useUiStore.getState().setEditorMode("raw");
          break;
        case APP_MENU_COMMANDS.renameActiveFile:
          handlePaletteCommand("rename-active-file");
          break;
        case APP_MENU_COMMANDS.renderedMode:
          useUiStore.getState().setEditorMode("rendered");
          break;
        case APP_MENU_COMMANDS.toggleFocusMode:
          handlePaletteCommand("toggle-focus-mode");
          break;
        case APP_MENU_COMMANDS.revealActiveFile:
          handlePaletteCommand("reveal-active-file");
          break;
        case APP_MENU_COMMANDS.revertLastSnapshot:
          handlePaletteCommand("revert-last-snapshot");
          break;
        case APP_MENU_COMMANDS.reviewBrief:
          handlePaletteCommand("review-brief");
          break;
        case APP_MENU_COMMANDS.toggleFiles:
          useUiStore.getState().toggleWorkspacePane();
          break;
        case APP_MENU_COMMANDS.find:
        case APP_MENU_COMMANDS.save:
          dispatchEditorMenuCommand(command);
          break;
      }
    },
    [checkForUpdates, handlePaletteCommand],
  );

  const flushProviderStreamDeltas = useCallback(() => {
    providerStreamFrameRef.current = null;
    const bufferedDeltas = providerStreamBufferRef.current;
    if (bufferedDeltas.size === 0) {
      return;
    }

    providerStreamBufferRef.current = new Map();

    setProviderActionState((current) => {
      const bufferedText = current.runId ? bufferedDeltas.get(current.runId) : null;
      return bufferedText
        ? { ...current, streamedText: `${current.streamedText}${bufferedText}` }
        : current;
    });
    setProviderDocumentActionState((current) => {
      const bufferedText = current.runId ? bufferedDeltas.get(current.runId) : null;
      return bufferedText
        ? { ...current, streamedText: `${current.streamedText}${bufferedText}` }
        : current;
    });
  }, []);

  useEffect(() => {
    if (!isDesktopBackend()) {
      return;
    }

    let cancelled = false;
    let stopListening: (() => void) | null = null;

    void listenBackend<string>(APP_MENU_COMMAND_EVENT, (event) => {
      if (cancelled || !isAppMenuCommand(event.payload)) {
        return;
      }

      handleAppMenuCommand(event.payload);
    })
      .then((unlisten) => {
        if (cancelled) {
          safeUnlisten(unlisten);
          return;
        }

        stopListening = unlisten;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (stopListening) {
        safeUnlisten(stopListening);
      }
    };
  }, [handleAppMenuCommand]);

  useEffect(() => {
    if (!isDesktopBackend()) {
      return;
    }

    let cancelled = false;
    let stopListening: (() => void) | null = null;

    void listenBackend<ProviderStreamEvent>(PROVIDER_STREAM_EVENT, (event) => {
      if (cancelled || event.payload.phase !== "delta" || !event.payload.text) {
        return;
      }

      providerStreamBufferRef.current.set(
        event.payload.runId,
        `${providerStreamBufferRef.current.get(event.payload.runId) ?? ""}${event.payload.text}`,
      );

      if (providerStreamFrameRef.current === null) {
        providerStreamFrameRef.current = window.requestAnimationFrame(flushProviderStreamDeltas);
      }
    })
      .then((unlisten) => {
        if (cancelled) {
          safeUnlisten(unlisten);
          return;
        }

        stopListening = unlisten;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (providerStreamFrameRef.current !== null) {
        window.cancelAnimationFrame(providerStreamFrameRef.current);
        providerStreamFrameRef.current = null;
      }
      providerStreamBufferRef.current.clear();
      if (stopListening) {
        safeUnlisten(stopListening);
      }
    };
  }, [flushProviderStreamDeltas]);

  const cancelProviderRun = useCallback(async (runId: string | null) => {
    if (!runId) {
      return;
    }

    cancelledProviderRunsRef.current.add(runId);
    setProviderActionState((current) =>
      current.runId === runId
        ? { action: null, errorMessage: null, provider: null, runId: null, streamedText: "", threadId: null }
        : current,
    );
    setProviderDocumentActionState((current) =>
      current.runId === runId
        ? {
            action: null,
            documentId: null,
            errorMessage: null,
            provider: null,
            runId: null,
            streamedText: "",
          }
        : current,
    );

    try {
      await invokeBackend("cancel_provider_action", { runId });
    } catch (error) {
      const message = getErrorMessage(error, "Unable to stop the provider run.");
      setProviderActionState((current) =>
        current.runId === runId ? { ...current, action: null, errorMessage: message } : current,
      );
      setProviderDocumentActionState((current) =>
        current.runId === runId ? { ...current, action: null, errorMessage: message } : current,
      );
    }
  }, []);

  const providerSetupMessage = useCallback(
    (provider: AgentProviderId) => {
      if (!providerReadiness.length) {
        return providerReadinessError
          ? "Provider setup could not be checked. Open Providers from the top bar and refresh."
          : null;
      }

      const readiness = providerReadiness.find((entry) => entry.id === provider);
      if (readiness?.ready) {
        return null;
      }

      if (!hasReadyProvider) {
        return "Set up Codex or Claude Code in Providers before running Ask or Revise.";
      }

      return `${formatProviderName(provider)} is not ready. Open Providers from the top bar to finish setup.`;
    },
    [hasReadyProvider, providerReadiness, providerReadinessError],
  );

  const runProviderThreadAction = useCallback(
    async (
      provider: AgentProviderId,
      action: ProviderThreadActionKind,
      threadId: string,
      instruction: string,
      passName: string | null,
    ) => {
      if (!workspace || !activeDocument) {
        return;
      }

      if (isEditorDirty) {
        const message = "Save the draft before running an agent.";
        setProviderActionState({
          action: null,
          errorMessage: message,
          provider,
          runId: null,
          streamedText: "",
          threadId,
        });
        throw new Error(message);
      }

      const setupMessage = providerSetupMessage(provider);
      if (setupMessage) {
        setProviderActionState({
          action: null,
          errorMessage: setupMessage,
          provider,
          runId: null,
          streamedText: "",
          threadId,
        });
        void loadProviderReadiness();
        throw new Error(setupMessage);
      }

      const runId = createRunId();
      cancelledProviderRunsRef.current.delete(runId);
      setProviderActionState({
        action,
        errorMessage: null,
        provider,
        runId,
        streamedText: "",
        threadId,
      });

      try {
        const result = await invokeBackend<ProviderThreadActionResult>("run_provider_thread_action", {
          action,
          documentId: activeDocument.id,
          documentRelativePath: activeDocument.relativePath,
          instruction,
          passName,
          provider,
          runId,
          threadId,
          workspaceRoot: workspace.rootPath,
        });
        upsertThread(result.thread);
        if (result.proposal) {
          upsertProposal(result.proposal);
        }
      } catch (error) {
        if (cancelledProviderRunsRef.current.has(runId)) {
          cancelledProviderRunsRef.current.delete(runId);
          setProviderActionState({
            action: null,
            errorMessage: null,
            provider: null,
            runId: null,
            streamedText: "",
            threadId: null,
          });
          return;
        }
        const message = getErrorMessage(
          error,
          `Unable to run ${formatProviderName(provider)} for this thread.`,
        );
        setProviderActionState({
          action: null,
          errorMessage: message,
          provider,
          runId: null,
          streamedText: "",
          threadId,
        });
        throw new Error(message);
      }

      setProviderActionState({
        action: null,
        errorMessage: null,
        provider: null,
        runId: null,
        streamedText: "",
        threadId: null,
      });
    },
    [
      activeDocument,
      isEditorDirty,
      loadProviderReadiness,
      providerSetupMessage,
      upsertProposal,
      upsertThread,
      workspace,
    ],
  );

  const runProviderDocumentAction = useCallback(
    async (
      provider: AgentProviderId,
      action: ProviderDocumentActionKind,
      instruction: string,
      passName: string | null,
    ) => {
      if (!workspace || !activeDocument) {
        return;
      }

      const trimmedInstruction = instruction.trim();
      if (!trimmedInstruction) {
        const message = "Enter a document-level instruction first.";
        setProviderDocumentActionState({
          action: null,
          documentId: activeDocument.id,
          errorMessage: message,
          provider,
          runId: null,
          streamedText: "",
        });
        throw new Error(message);
      }

      if (isEditorDirty) {
        const message = "Save the draft before running an agent.";
        setProviderDocumentActionState({
          action: null,
          documentId: activeDocument.id,
          errorMessage: message,
          provider,
          runId: null,
          streamedText: "",
        });
        throw new Error(message);
      }

      const setupMessage = providerSetupMessage(provider);
      if (setupMessage) {
        setProviderDocumentActionState({
          action: null,
          documentId: activeDocument.id,
          errorMessage: setupMessage,
          provider,
          runId: null,
          streamedText: "",
        });
        void loadProviderReadiness();
        throw new Error(setupMessage);
      }

      const runId = createRunId();
      cancelledProviderRunsRef.current.delete(runId);
      setProviderDocumentActionState({
        action,
        documentId: activeDocument.id,
        errorMessage: null,
        provider,
        runId,
        streamedText: "",
      });

      try {
        const result = await invokeBackend<ProviderThreadActionResult>("run_provider_document_action", {
          action,
          documentId: activeDocument.id,
          documentRelativePath: activeDocument.relativePath,
          instruction: trimmedInstruction,
          passName,
          provider,
          runId,
          workspaceRoot: workspace.rootPath,
        });
        upsertThread(result.thread);
        selectThread(result.thread.id);
        if (result.proposal) {
          upsertProposal(result.proposal);
        }
      } catch (error) {
        if (cancelledProviderRunsRef.current.has(runId)) {
          cancelledProviderRunsRef.current.delete(runId);
          setProviderDocumentActionState({
            action: null,
            documentId: null,
            errorMessage: null,
            provider: null,
            runId: null,
            streamedText: "",
          });
          return;
        }
        const message = getErrorMessage(
          error,
          `Unable to run ${formatProviderName(provider)} for this document.`,
        );
        setProviderDocumentActionState({
          action: null,
          documentId: activeDocument.id,
          errorMessage: message,
          provider,
          runId: null,
          streamedText: "",
        });
        throw new Error(message);
      }

      setProviderDocumentActionState({
        action: null,
        documentId: null,
        errorMessage: null,
        provider: null,
        runId: null,
        streamedText: "",
      });
    },
    [
      activeDocument,
      isEditorDirty,
      loadProviderReadiness,
      providerSetupMessage,
      selectThread,
      upsertProposal,
      upsertThread,
      workspace,
    ],
  );

  const openBriefThread = useCallback(
    async (relativePath: string, threadId: string) => {
      setAppView("editor");
      await loadDocument(relativePath);
      selectThread(threadId);
    },
    [selectThread],
  );

  const openProjectSearchResult = useCallback(async (result: ProjectSearchResult) => {
    setAppView("editor");
    await loadDocument(result.relativePath);
    setEditorNavigationRequest({
      id: Date.now(),
      line: result.line,
      relativePath: result.relativePath,
    });
  }, []);

  const importImageAssetForActiveDocument = useCallback(
    async (file: File) => {
      const imported = await importImageAssetFile(file);
      if (!activeDocument) {
        return imported.relativePath;
      }

      return relativePathFromDocument(activeDocument.absolutePath, imported.absolutePath);
    },
    [activeDocument],
  );

  return (
    <main
      className={`app-shell ${isFocusModeEnabled ? "is-focus-mode" : ""} ${
        isFocusChromeDimmed ? "is-focus-chrome-dimmed" : ""
      }`}
    >
      <WorkspaceEffects />
      <header className="topbar">
        <div className="topbar-brand">
          <div className="wordmark">
            Margent
            {workspace && status !== "ready" ? (
              <span
                aria-label={`Workspace status: ${status}`}
                className={`topbar-status-dot status-${status}`}
                title={status}
              />
            ) : null}
          </div>
          {workspace ? null : (
            <div className="eyebrow-lbl topbar-eyebrow">Agentic marginalia for markdown</div>
          )}
        </div>

        <div className="topbar-crumb">{topbarContext}</div>

        {activeProviderActivity ? (
          <div aria-live="polite" className="topbar-agent-status" role="status">
            <span aria-hidden="true" className="topbar-agent-dot" />
            <span>{activeProviderActivity.providerLabel}</span>
            <span aria-hidden="true">·</span>
            <span>{activeProviderActivity.actionLabel}</span>
          </div>
        ) : null}

        <div className="topbar-actions">
          <button
            className="ghost-button topbar-button"
            onClick={() => setCommandPaletteMode("commands")}
          >
            Commands
          </button>
          {workspace ? (
            <button
              aria-pressed={appView === "project-search"}
              className="ghost-button topbar-button"
              onClick={() => setAppView("project-search")}
            >
              Search
            </button>
          ) : null}
          {workspace ? (
            <button
              aria-pressed={appView === "review-brief"}
              className="ghost-button topbar-button"
              onClick={() => {
                setAppView((current) =>
                  current === "review-brief" ? "editor" : "review-brief",
                );
              }}
            >
              Review Brief
            </button>
          ) : null}
          <button
            aria-pressed={appView === "providers"}
            className="ghost-button topbar-button"
            onClick={() => {
              setAppView((current) => (current === "providers" ? "editor" : "providers"));
              if (appView !== "providers") {
                void loadProviderReadiness();
              }
            }}
          >
            Providers
          </button>
          {recentWorkspaces.length ? (
            <div className="topbar-recent">
              <button
                aria-expanded={isRecentMenuOpen}
                className="ghost-button topbar-button"
                onClick={() => setIsRecentMenuOpen((current) => !current)}
                type="button"
              >
                Open Recent
              </button>
              {isRecentMenuOpen ? (
                <div className="topbar-recent-menu" role="menu">
                  {recentWorkspaces.map((recent, index) => (
                    <button
                      key={`${recent.rootPath}-${recent.activeRelativePath ?? ""}`}
                      onClick={() => void openRecentWorkspace(index)}
                      role="menuitem"
                      title={recent.rootPath}
                      type="button"
                    >
                      <span>{recent.label}</span>
                      {recent.activeRelativePath ? <small>{recent.activeRelativePath}</small> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {workspace ? (
            <button
              className="ghost-button topbar-button topbar-pane-toggle"
              onClick={toggleWorkspacePane}
            >
              {isWorkspacePaneCollapsed ? "Show Files" : "Hide Files"}
            </button>
          ) : null}
          <button
            className="ghost-button topbar-button topbar-open-folder"
            onClick={() => void openFolderWorkspace()}
          >
            Open Folder
          </button>
          <button
            className="ghost-button topbar-button topbar-open-file"
            onClick={() => void openFileWorkspace()}
          >
            Open File
          </button>
        </div>
      </header>

      {errorMessage ? <div className="banner error-banner">{errorMessage}</div> : null}
      {saveConflict ? (
        <SaveConflictBanner
          conflict={saveConflict}
          isCompareOpen={isSaveConflictCompareOpen}
          isSaving={isSaving}
          onCompare={() => setIsSaveConflictCompareOpen((current) => !current)}
          onKeep={() => void keepMargentVersionForSaveConflict()}
          onReload={reloadSaveConflictDiskVersion}
        />
      ) : null}
      {exportStatusMessage ? (
        <div className="banner info-banner">{exportStatusMessage}</div>
      ) : null}

      {commandPaletteMode ? (
        <CommandPalette
          activeRelativePath={activeDocument?.relativePath ?? null}
          commands={paletteCommands}
          documents={workspace?.documents ?? []}
          mode={commandPaletteMode}
          onClose={() => setCommandPaletteMode(null)}
          onSelectCommand={handlePaletteCommand}
          onSelectDocument={(relativePath) => {
            setAppView("editor");
            void loadDocument(relativePath);
          }}
        />
      ) : null}

      {workspace ? (
        <section
          className={`app-layout editor-layout ${
            isWorkspacePaneCollapsed ? "workspace-collapsed" : ""
          }`}
        >
          <aside className={`app-panel left-panel ${isWorkspacePaneCollapsed ? "is-collapsed" : ""}`}>
            <FileBrowser
              actionRequest={fileActionRequest}
              activeRelativePath={activeDocument?.relativePath ?? null}
              documents={workspace.documents}
              isCollapsed={isWorkspacePaneCollapsed}
              isRefreshing={status === "loading"}
              onCreateDocument={(relativePath) => void createMarkdownFile(relativePath)}
              onDeleteDocument={(relativePath) => void deleteMarkdownFile(relativePath)}
              onRefresh={() => void refreshWorkspaceFiles()}
              onRenameDocument={(fromRelativePath, toRelativePath) =>
                void renameMarkdownFile(fromRelativePath, toRelativePath)
              }
              onRevealDocument={(relativePath) => void revealMarkdownFile(relativePath)}
              onSelectDocument={(relativePath) => {
                setAppView("editor");
                void loadDocument(relativePath);
              }}
              onToggleCollapse={toggleWorkspacePane}
              rootPath={workspace.rootPath}
            />
          </aside>
          <section className="app-panel center-panel">
            {appView === "providers" ? (
              <ProviderSetupView
                errorMessage={providerReadinessError}
                isLoading={isProviderReadinessLoading}
                onOpenExternalUrl={openExternalUrl}
                onRefresh={() => void loadProviderReadiness()}
                providers={providerReadiness}
              />
            ) : appView === "review-brief" ? (
              <ReviewBriefView
                activeActionId={reviewBriefState.activeActionId}
                activeActionKind={reviewBriefState.activeActionKind}
                entries={reviewBriefState.entries}
                errorMessage={reviewBriefState.errorMessage}
                isLoading={reviewBriefState.isLoading}
                onAcceptProposal={reviewBriefState.acceptProposal}
                onOpenThread={openBriefThread}
                onRefresh={reviewBriefState.loadBrief}
                onRejectProposal={reviewBriefState.rejectProposal}
                onReplyToThread={reviewBriefState.replyToThread}
                resolvedCount={reviewBriefState.resolvedCount}
              />
            ) : appView === "project-search" ? (
              <ProjectSearchView
                onOpenResult={openProjectSearchResult}
                workspaceRoot={workspace.rootPath}
              />
            ) : (
              <EditorPane
                addReply={threadState.addReply}
                createDocumentThread={threadState.createDocumentThread}
                createThreadFromSelection={threadState.createThreadFromSelection}
                deleteThread={threadState.deleteThread}
                document={activeDocument}
                isThreadSaving={threadState.isSaving}
                importImageAsset={importImageAssetForActiveDocument}
                loadThread={threadState.loadThread}
                navigationRequest={editorNavigationRequest}
                onAcceptProposal={proposalState.acceptProposal}
                onCancelProviderRun={cancelProviderRun}
                onFocusModeTypingActivity={handleFocusModeTypingActivity}
                onRejectProposal={proposalState.rejectProposal}
                onRunProviderDocumentAction={runProviderDocumentAction}
                onRunProviderThreadAction={runProviderThreadAction}
                onSave={handleEditorSave}
                onThreadSelect={threadState.selectThread}
                providerActionState={providerActionState}
                providerDocumentActionState={providerDocumentActionState}
                proposalActionKind={proposalState.activeActionKind}
                proposalActionProposalId={proposalState.activeActionProposalId}
                proposalErrorMessage={proposalState.errorMessage}
                proposals={proposalState.proposals}
                reopenThread={threadState.reopenThread}
                reviewPasses={reviewPasses}
                resolveThread={threadState.resolveThread}
                selectedReviewPassName={preferredReviewPassName}
                setSelectedReviewPassName={setPreferredReviewPassName}
                selectedThreadId={threadState.selectedThreadId}
                threads={threadState.threads}
              />
            )}
          </section>
        </section>
      ) : appView === "providers" ? (
        <section className="empty-state provider-setup-empty-state">
          <ProviderSetupView
            errorMessage={providerReadinessError}
            isLoading={isProviderReadinessLoading}
            onOpenExternalUrl={openExternalUrl}
            onRefresh={() => void loadProviderReadiness()}
            providers={providerReadiness}
          />
        </section>
      ) : (
        <section className="empty-state">
          <div className="empty-state-content">
            <h2>Open a Markdown workspace to begin reviewing.</h2>
            <p>
              Margent is a review companion for Markdown files. Open a workspace, leave threaded
              comments, and use agents to revise targeted passages.
            </p>
            {!hasReadyProvider ? (
              <button
                className="empty-state-link-button"
                onClick={() => {
                  setAppView("providers");
                  void loadProviderReadiness();
                }}
                type="button"
              >
                Set up an agent
              </button>
            ) : null}
            <div className="hero-actions">
              <button className="primary-button" onClick={() => void openFolderWorkspace()}>
                Choose Folder
              </button>
              <button className="empty-state-link-button" onClick={() => void openFileWorkspace()}>
                Choose Single File
              </button>
            </div>
            {recentWorkspaces.length ? (
              <section className="recent-workspaces" aria-label="Recent workspaces">
                <h3>Recent</h3>
                <ul>
                  {recentWorkspaces.map((recent) => (
                    <li key={recent.rootPath}>
                      <button
                        onClick={() =>
                          void openWorkspacePath(recent.openedPath ?? recent.rootPath, {
                            preferredRelativePath: recent.activeRelativePath,
                          })
                        }
                        title={recent.rootPath}
                        type="button"
                      >
                        <span>{recent.label}</span>
                        {recent.activeRelativePath ? <small>{recent.activeRelativePath}</small> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </section>
      )}
    </main>
  );
}

function SaveConflictBanner({
  conflict,
  isCompareOpen,
  isSaving,
  onCompare,
  onKeep,
  onReload,
}: {
  conflict: SaveConflict;
  isCompareOpen: boolean;
  isSaving: boolean;
  onCompare: () => void;
  onKeep: () => void;
  onReload: () => void;
}) {
  return (
    <section className="banner save-conflict-banner" aria-live="polite">
      <div className="save-conflict-summary">
        <div>
          <strong>Document changed on disk.</strong>
          <span>{conflict.relativePath}</span>
        </div>
        <div className="save-conflict-actions">
          <button className="ghost-button" onClick={onCompare} type="button">
            {isCompareOpen ? "Hide Compare" : "Compare"}
          </button>
          <button className="ghost-button" disabled={isSaving} onClick={onReload} type="button">
            Reload Disk Version
          </button>
          <button className="primary-button" disabled={isSaving} onClick={onKeep} type="button">
            Keep Margent Version
          </button>
        </div>
      </div>
      {isCompareOpen ? (
        <div className="save-conflict-compare">
          <section>
            <h3>Margent draft</h3>
            <pre>{conflict.localContent}</pre>
          </section>
          <section>
            <h3>Disk version</h3>
            <pre>{conflict.diskDocument.content}</pre>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default App;

const EditorPane = memo(function EditorPane({
  addReply,
  createDocumentThread,
  createThreadFromSelection,
  deleteThread,
  document,
  isThreadSaving,
  importImageAsset,
  loadThread,
  navigationRequest,
  onAcceptProposal,
  onCancelProviderRun,
  onFocusModeTypingActivity,
  onRejectProposal,
  reviewPasses,
  onRunProviderDocumentAction,
  onRunProviderThreadAction,
  onSave,
  onThreadSelect,
  providerActionState,
  providerDocumentActionState,
  proposalActionKind,
  proposalActionProposalId,
  proposalErrorMessage,
  proposals,
  reopenThread,
  selectedReviewPassName,
  setSelectedReviewPassName,
  resolveThread,
  selectedThreadId,
  threads,
}: {
  addReply: (threadId: string, body: string) => Promise<void>;
  createDocumentThread: (body: string) => Promise<void>;
  createThreadFromSelection: (
    body: string,
    selection: EditorSelectionSnapshot,
    content: string,
  ) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  document: DocumentPayload | null;
  isThreadSaving: boolean;
  importImageAsset: (file: File) => Promise<string>;
  loadThread: (threadId: string | null) => Promise<ThreadRecord | null>;
  navigationRequest: EditorNavigationRequest | null;
  onAcceptProposal: (proposalId: string, updatedDocumentText?: string) => Promise<void>;
  onCancelProviderRun: (runId: string | null) => Promise<void>;
  onFocusModeTypingActivity?: () => void;
  onRejectProposal: (proposalId: string) => Promise<void>;
  reviewPasses: ReviewPassSummary[];
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
  selectedReviewPassName: string | null;
  setSelectedReviewPassName: (passName: string | null) => void;
  resolveThread: (threadId: string) => Promise<void>;
  selectedThreadId: string | null;
  threads: ThreadRecord[];
}) {
  const isSaving = useWorkspaceStore((state) => state.isSaving);
  const setIsEditorDirty = useWorkspaceStore((state) => state.setIsEditorDirty);

  return (
    <DocumentEditor
      addReply={addReply}
      createDocumentThread={createDocumentThread}
      createThreadFromSelection={createThreadFromSelection}
      deleteThread={deleteThread}
      document={document}
      importImageAsset={importImageAsset}
      isSaving={isSaving}
      isThreadSaving={isThreadSaving}
      loadThread={loadThread}
      navigationRequest={navigationRequest}
      onAcceptProposal={onAcceptProposal}
      onCancelProviderRun={onCancelProviderRun}
      onFocusModeTypingActivity={onFocusModeTypingActivity}
      onRejectProposal={onRejectProposal}
      onRunProviderDocumentAction={onRunProviderDocumentAction}
      onRunProviderThreadAction={onRunProviderThreadAction}
      onDirtyChange={setIsEditorDirty}
      onSave={onSave}
      onThreadSelect={onThreadSelect}
      providerActionState={providerActionState}
      providerDocumentActionState={providerDocumentActionState}
      proposalActionKind={proposalActionKind}
      proposalActionProposalId={proposalActionProposalId}
      proposalErrorMessage={proposalErrorMessage}
      proposals={proposals}
      reopenThread={reopenThread}
      reviewPasses={reviewPasses}
      resolveThread={resolveThread}
      selectedReviewPassName={selectedReviewPassName}
      setSelectedReviewPassName={setSelectedReviewPassName}
      selectedThreadId={selectedThreadId}
      threads={threads}
    />
  );
});

async function importImageAssetFile(file: File) {
  const buffer = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  return importWorkspaceAsset(suggestedImageAssetName(file), bytes);
}

function relativePathFromDocument(documentAbsolutePath: string, targetAbsolutePath: string) {
  const documentDirectory = documentAbsolutePath.slice(
    0,
    Math.max(0, documentAbsolutePath.lastIndexOf("/")),
  );
  const fromSegments = documentDirectory.split("/").filter(Boolean);
  const targetSegments = targetAbsolutePath.split("/").filter(Boolean);
  let commonLength = 0;
  while (
    commonLength < fromSegments.length &&
    commonLength < targetSegments.length &&
    fromSegments[commonLength] === targetSegments[commonLength]
  ) {
    commonLength += 1;
  }

  const upwardSegments = fromSegments.slice(commonLength).map(() => "..");
  const downwardSegments = targetSegments.slice(commonLength);
  const relativePath = [...upwardSegments, ...downwardSegments].join("/");
  return relativePath || targetSegments[targetSegments.length - 1] || "image.png";
}

function suggestedImageAssetName(file: File) {
  if (file.name.trim()) {
    return file.name;
  }

  const extension = imageMimeExtension(file.type) ?? "png";
  return `pasted-image.${extension}`;
}

function imageMimeExtension(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    default:
      return null;
  }
}

function WorkspaceEffects() {
  useWorkspaceEffects();
  return null;
}

function getLastPathSegment(path: string) {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function formatProviderName(provider: AgentProviderId) {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function createRunId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isEditorEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest(".cm-editor, .code-editor-host"));
}
