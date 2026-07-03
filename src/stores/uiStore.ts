import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type EditorMode = "raw" | "rendered";
export type PreferredAgentProvider = "codex" | "claude";
export type ThemeMode = "system" | "light" | "dark";

export const COMMENT_DOCK_DEFAULT_WIDTH = 380;
export const COMMENT_DOCK_MAX_WIDTH = 760;
export const COMMENT_DOCK_MIN_WIDTH = 340;
export const EDITOR_ZOOM_DEFAULT_PERCENT = 100;
export const EDITOR_ZOOM_MAX_PERCENT = 200;
export const EDITOR_ZOOM_MIN_PERCENT = 50;
export const EDITOR_ZOOM_STEP_PERCENT = 10;

interface UiStore {
  commentDockWidth: number;
  editorMode: EditorMode;
  editorZoomPercent: number;
  isDocumentOutlineVisible: boolean;
  isFocusModeEnabled: boolean;
  isFormattingToolbarVisible: boolean;
  isWorkspacePaneCollapsed: boolean;
  preferredAgentProvider: PreferredAgentProvider;
  preferredReviewPassName: string | null;
  reset: () => void;
  resetEditorZoom: () => void;
  setCommentDockWidth: (commentDockWidth: number) => void;
  setDocumentOutlineVisible: (isDocumentOutlineVisible: boolean) => void;
  setEditorMode: (editorMode: EditorMode) => void;
  setEditorZoomPercent: (editorZoomPercent: number) => void;
  setFocusModeEnabled: (isFocusModeEnabled: boolean) => void;
  setFormattingToolbarVisible: (isFormattingToolbarVisible: boolean) => void;
  setPreferredAgentProvider: (preferredAgentProvider: PreferredAgentProvider) => void;
  setPreferredReviewPassName: (preferredReviewPassName: string | null) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  setWorkspacePaneCollapsed: (isWorkspacePaneCollapsed: boolean) => void;
  themeMode: ThemeMode;
  toggleDocumentOutline: () => void;
  toggleFocusMode: () => void;
  toggleFormattingToolbar: () => void;
  toggleWorkspacePane: () => void;
  zoomEditorIn: () => void;
  zoomEditorOut: () => void;
}

interface PersistedUiState {
  commentDockWidth: number;
  editorMode: EditorMode;
  editorZoomPercent: number;
  isDocumentOutlineVisible: boolean;
  isFocusModeEnabled: boolean;
  isFormattingToolbarVisible: boolean;
  isWorkspacePaneCollapsed: boolean;
  preferredAgentProvider: PreferredAgentProvider;
  preferredReviewPassName: string | null;
  themeMode: ThemeMode;
}

const STORAGE_KEY = "margent:ui";

const defaultState: PersistedUiState = {
  commentDockWidth: COMMENT_DOCK_DEFAULT_WIDTH,
  editorMode: "rendered",
  editorZoomPercent: EDITOR_ZOOM_DEFAULT_PERCENT,
  isDocumentOutlineVisible: false,
  isFocusModeEnabled: false,
  isFormattingToolbarVisible: true,
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

export function normalizeEditorZoomPercent(zoomPercent: unknown) {
  if (typeof zoomPercent !== "number" || !Number.isFinite(zoomPercent)) {
    return EDITOR_ZOOM_DEFAULT_PERCENT;
  }

  const rounded = Math.round(zoomPercent / EDITOR_ZOOM_STEP_PERCENT) * EDITOR_ZOOM_STEP_PERCENT;
  return Math.max(EDITOR_ZOOM_MIN_PERCENT, Math.min(rounded, EDITOR_ZOOM_MAX_PERCENT));
}

function normalizePersistedUiState(value: unknown): PersistedUiState {
  const persisted = isObject(value) ? value : {};
  const width = persisted.commentDockWidth;

  return {
    commentDockWidth:
      typeof width === "number" ? clampCommentDockWidth(width) : COMMENT_DOCK_DEFAULT_WIDTH,
    editorMode: normalizeEditorMode(persisted.editorMode),
    editorZoomPercent: normalizeEditorZoomPercent(persisted.editorZoomPercent),
    isDocumentOutlineVisible: Boolean(persisted.isDocumentOutlineVisible),
    isFocusModeEnabled: Boolean(persisted.isFocusModeEnabled),
    isFormattingToolbarVisible:
      "isFormattingToolbarVisible" in persisted
        ? Boolean(persisted.isFormattingToolbarVisible)
        : true,
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
    editorZoomPercent: state.editorZoomPercent,
    isDocumentOutlineVisible: state.isDocumentOutlineVisible,
    isFocusModeEnabled: state.isFocusModeEnabled,
    isFormattingToolbarVisible: state.isFormattingToolbarVisible,
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
      resetEditorZoom: () => set({ editorZoomPercent: EDITOR_ZOOM_DEFAULT_PERCENT }),
      setCommentDockWidth: (commentDockWidth) =>
        set({ commentDockWidth: clampCommentDockWidth(commentDockWidth) }),
      setDocumentOutlineVisible: (isDocumentOutlineVisible) =>
        set({ isDocumentOutlineVisible }),
      setEditorMode: (editorMode) => set({ editorMode }),
      setEditorZoomPercent: (editorZoomPercent) =>
        set({ editorZoomPercent: normalizeEditorZoomPercent(editorZoomPercent) }),
      setFocusModeEnabled: (isFocusModeEnabled) => set({ isFocusModeEnabled }),
      setFormattingToolbarVisible: (isFormattingToolbarVisible) =>
        set({ isFormattingToolbarVisible }),
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
      toggleFormattingToolbar: () =>
        set({ isFormattingToolbarVisible: !get().isFormattingToolbarVisible }),
      toggleWorkspacePane: () =>
        set({ isWorkspacePaneCollapsed: !get().isWorkspacePaneCollapsed }),
      zoomEditorIn: () =>
        set({
          editorZoomPercent: normalizeEditorZoomPercent(
            get().editorZoomPercent + EDITOR_ZOOM_STEP_PERCENT,
          ),
        }),
      zoomEditorOut: () =>
        set({
          editorZoomPercent: normalizeEditorZoomPercent(
            get().editorZoomPercent - EDITOR_ZOOM_STEP_PERCENT,
          ),
        }),
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
