import { create } from "zustand";

export type EditorMode = "raw" | "rendered";
export type PreferredAgentProvider = "codex" | "claude";
export type ThemeMode = "system" | "light" | "dark";

export const COMMENT_DOCK_DEFAULT_WIDTH = 380;
export const COMMENT_DOCK_MAX_WIDTH = 760;
export const COMMENT_DOCK_MIN_WIDTH = 340;

interface UiStore {
  commentDockWidth: number;
  editorMode: EditorMode;
  isDocumentOutlineVisible: boolean;
  isFocusModeEnabled: boolean;
  isWorkspacePaneCollapsed: boolean;
  preferredAgentProvider: PreferredAgentProvider;
  preferredReviewPassName: string | null;
  reset: () => void;
  setCommentDockWidth: (commentDockWidth: number) => void;
  setDocumentOutlineVisible: (isDocumentOutlineVisible: boolean) => void;
  setEditorMode: (editorMode: EditorMode) => void;
  setFocusModeEnabled: (isFocusModeEnabled: boolean) => void;
  setPreferredAgentProvider: (preferredAgentProvider: PreferredAgentProvider) => void;
  setPreferredReviewPassName: (preferredReviewPassName: string | null) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  setWorkspacePaneCollapsed: (isWorkspacePaneCollapsed: boolean) => void;
  themeMode: ThemeMode;
  toggleDocumentOutline: () => void;
  toggleFocusMode: () => void;
  toggleWorkspacePane: () => void;
}

interface PersistedUiState {
  commentDockWidth: number;
  editorMode: EditorMode;
  isDocumentOutlineVisible: boolean;
  isFocusModeEnabled: boolean;
  isWorkspacePaneCollapsed: boolean;
  preferredAgentProvider: PreferredAgentProvider;
  preferredReviewPassName: string | null;
  themeMode: ThemeMode;
}

const STORAGE_KEY = "margent:ui";

const defaultState: PersistedUiState = {
  commentDockWidth: COMMENT_DOCK_DEFAULT_WIDTH,
  editorMode: "rendered",
  isDocumentOutlineVisible: false,
  isFocusModeEnabled: false,
  isWorkspacePaneCollapsed: false,
  preferredAgentProvider: "codex",
  preferredReviewPassName: null,
  themeMode: "system",
};

function normalizeThemeMode(themeMode: unknown): ThemeMode {
  if (themeMode === "light" || themeMode === "dark") {
    return themeMode;
  }
  return "system";
}

function clampCommentDockWidth(width: number) {
  return Math.max(COMMENT_DOCK_MIN_WIDTH, Math.min(width, COMMENT_DOCK_MAX_WIDTH));
}

function readPersistedState(): PersistedUiState {
  if (typeof window === "undefined") {
    return defaultState;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultState;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedUiState>;
    return {
      commentDockWidth:
        typeof parsed.commentDockWidth === "number"
          ? clampCommentDockWidth(parsed.commentDockWidth)
          : COMMENT_DOCK_DEFAULT_WIDTH,
      editorMode: parsed.editorMode === "raw" ? "raw" : "rendered",
      isDocumentOutlineVisible: Boolean(parsed.isDocumentOutlineVisible),
      isFocusModeEnabled: Boolean(parsed.isFocusModeEnabled),
      isWorkspacePaneCollapsed: Boolean(parsed.isWorkspacePaneCollapsed),
      preferredAgentProvider:
        parsed.preferredAgentProvider === "claude" ? "claude" : "codex",
      preferredReviewPassName:
        typeof parsed.preferredReviewPassName === "string" &&
        parsed.preferredReviewPassName.trim()
          ? parsed.preferredReviewPassName.trim()
          : null,
      themeMode: normalizeThemeMode(parsed.themeMode),
    };
  } catch {
    return defaultState;
  }
}

function writePersistedState(state: PersistedUiState) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearPersistedState() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}

export const useUiStore = create<UiStore>((set, get) => ({
  ...readPersistedState(),
  reset: () => {
    set(defaultState);
    clearPersistedState();
  },
  setCommentDockWidth: (commentDockWidth) => {
    const nextWidth = clampCommentDockWidth(commentDockWidth);
    set({ commentDockWidth: nextWidth });
    writePersistedState({
      commentDockWidth: nextWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  setDocumentOutlineVisible: (isDocumentOutlineVisible) => {
    set({ isDocumentOutlineVisible });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  setEditorMode: (editorMode) => {
    set({ editorMode });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  setFocusModeEnabled: (isFocusModeEnabled) => {
    set({ isFocusModeEnabled });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  setPreferredAgentProvider: (preferredAgentProvider) => {
    set({ preferredAgentProvider });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  setPreferredReviewPassName: (preferredReviewPassName) => {
    const nextPassName = preferredReviewPassName?.trim() || null;
    set({ preferredReviewPassName: nextPassName });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: nextPassName,
      themeMode: get().themeMode,
    });
  },
  setThemeMode: (themeMode) => {
    set({ themeMode });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode,
    });
  },
  setWorkspacePaneCollapsed: (isWorkspacePaneCollapsed) => {
    set({ isWorkspacePaneCollapsed });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  toggleDocumentOutline: () => {
    const nextVisible = !get().isDocumentOutlineVisible;
    set({ isDocumentOutlineVisible: nextVisible });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: nextVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  toggleFocusMode: () => {
    const nextEnabled = !get().isFocusModeEnabled;
    set({ isFocusModeEnabled: nextEnabled });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: nextEnabled,
      isWorkspacePaneCollapsed: get().isWorkspacePaneCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
  toggleWorkspacePane: () => {
    const nextCollapsed = !get().isWorkspacePaneCollapsed;
    set({ isWorkspacePaneCollapsed: nextCollapsed });
    writePersistedState({
      commentDockWidth: get().commentDockWidth,
      editorMode: get().editorMode,
      isDocumentOutlineVisible: get().isDocumentOutlineVisible,
      isFocusModeEnabled: get().isFocusModeEnabled,
      isWorkspacePaneCollapsed: nextCollapsed,
      preferredAgentProvider: get().preferredAgentProvider,
      preferredReviewPassName: get().preferredReviewPassName,
      themeMode: get().themeMode,
    });
  },
}));
