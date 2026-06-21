import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

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

const legacyCompatibleUiStorage: StateStorage = {
  getItem(name) {
    if (typeof window === "undefined") {
      return null;
    }

    const raw = window.localStorage.getItem(name);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isObject(parsed) && "state" in parsed) {
        return raw;
      }

      return JSON.stringify({ state: parsed, version: 0 });
    } catch {
      return null;
    }
  },
  removeItem(name) {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(name);
    }
  },
  setItem(name, value) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(name, value);
    }
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeThemeMode(themeMode: unknown): ThemeMode {
  if (themeMode === "light" || themeMode === "dark") {
    return themeMode;
  }
  return "system";
}

function normalizeEditorMode(editorMode: unknown): EditorMode {
  return editorMode === "raw" ? "raw" : "rendered";
}

function normalizePreferredAgentProvider(provider: unknown): PreferredAgentProvider {
  return provider === "claude" ? "claude" : "codex";
}

function normalizePreferredReviewPassName(passName: unknown) {
  return typeof passName === "string" && passName.trim() ? passName.trim() : null;
}

function clampCommentDockWidth(width: number) {
  return Math.max(COMMENT_DOCK_MIN_WIDTH, Math.min(width, COMMENT_DOCK_MAX_WIDTH));
}

function normalizePersistedUiState(value: unknown): PersistedUiState {
  const persisted = isObject(value) ? value : {};
  const width = persisted.commentDockWidth;

  return {
    commentDockWidth:
      typeof width === "number" ? clampCommentDockWidth(width) : COMMENT_DOCK_DEFAULT_WIDTH,
    editorMode: normalizeEditorMode(persisted.editorMode),
    isDocumentOutlineVisible: Boolean(persisted.isDocumentOutlineVisible),
    isFocusModeEnabled: Boolean(persisted.isFocusModeEnabled),
    isWorkspacePaneCollapsed: Boolean(persisted.isWorkspacePaneCollapsed),
    preferredAgentProvider: normalizePreferredAgentProvider(persisted.preferredAgentProvider),
    preferredReviewPassName: normalizePreferredReviewPassName(persisted.preferredReviewPassName),
    themeMode: normalizeThemeMode(persisted.themeMode),
  };
}

function persistedStateFromStore(state: UiStore): PersistedUiState {
  return {
    commentDockWidth: state.commentDockWidth,
    editorMode: state.editorMode,
    isDocumentOutlineVisible: state.isDocumentOutlineVisible,
    isFocusModeEnabled: state.isFocusModeEnabled,
    isWorkspacePaneCollapsed: state.isWorkspacePaneCollapsed,
    preferredAgentProvider: state.preferredAgentProvider,
    preferredReviewPassName: state.preferredReviewPassName,
    themeMode: state.themeMode,
  };
}

export const useUiStore = create<UiStore>()(
  persist<UiStore, [], [], PersistedUiState>(
    (set, get) => ({
      ...defaultState,
      reset: () => {
        set(defaultState);
        legacyCompatibleUiStorage.removeItem(STORAGE_KEY);
      },
      setCommentDockWidth: (commentDockWidth) =>
        set({ commentDockWidth: clampCommentDockWidth(commentDockWidth) }),
      setDocumentOutlineVisible: (isDocumentOutlineVisible) =>
        set({ isDocumentOutlineVisible }),
      setEditorMode: (editorMode) => set({ editorMode }),
      setFocusModeEnabled: (isFocusModeEnabled) => set({ isFocusModeEnabled }),
      setPreferredAgentProvider: (preferredAgentProvider) =>
        set({ preferredAgentProvider }),
      setPreferredReviewPassName: (preferredReviewPassName) =>
        set({ preferredReviewPassName: normalizePreferredReviewPassName(preferredReviewPassName) }),
      setThemeMode: (themeMode) => set({ themeMode: normalizeThemeMode(themeMode) }),
      setWorkspacePaneCollapsed: (isWorkspacePaneCollapsed) =>
        set({ isWorkspacePaneCollapsed }),
      toggleDocumentOutline: () =>
        set({ isDocumentOutlineVisible: !get().isDocumentOutlineVisible }),
      toggleFocusMode: () => set({ isFocusModeEnabled: !get().isFocusModeEnabled }),
      toggleWorkspacePane: () =>
        set({ isWorkspacePaneCollapsed: !get().isWorkspacePaneCollapsed }),
    }),
    {
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedUiState(persistedState),
      }),
      name: STORAGE_KEY,
      partialize: persistedStateFromStore,
      storage: createJSONStorage(() => legacyCompatibleUiStorage),
    },
  ),
);
