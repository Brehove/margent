import { create } from "zustand";
import type { DocumentPayload, SaveConflict, WorkspaceSnapshot } from "../types/workspace";

type WorkspaceStatus = "idle" | "loading" | "ready" | "error";

interface WorkspaceStore {
  activeDocument: DocumentPayload | null;
  errorMessage: string | null;
  isEditorDirty: boolean;
  isSaving: boolean;
  pendingExternalDocument: DocumentPayload | null;
  saveConflict: SaveConflict | null;
  status: WorkspaceStatus;
  workspace: WorkspaceSnapshot | null;
  reset: () => void;
  setActiveDocument: (document: DocumentPayload | null) => void;
  setErrorMessage: (message: string | null) => void;
  setIsEditorDirty: (isEditorDirty: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  setPendingExternalDocument: (document: DocumentPayload | null) => void;
  setSaveConflict: (saveConflict: SaveConflict | null) => void;
  setStatus: (status: WorkspaceStatus) => void;
  setWorkspace: (workspace: WorkspaceSnapshot | null) => void;
}

const initialState = {
  activeDocument: null,
  errorMessage: null,
  isEditorDirty: false,
  isSaving: false,
  pendingExternalDocument: null,
  saveConflict: null,
  status: "idle" as WorkspaceStatus,
  workspace: null,
};

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  ...initialState,
  reset: () => set(initialState),
  setActiveDocument: (activeDocument) =>
    set({
      activeDocument,
      isEditorDirty: false,
      pendingExternalDocument: null,
      saveConflict: null,
    }),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setIsEditorDirty: (isEditorDirty) => set({ isEditorDirty }),
  setIsSaving: (isSaving) => set({ isSaving }),
  setPendingExternalDocument: (pendingExternalDocument) => set({ pendingExternalDocument }),
  setSaveConflict: (saveConflict) => set({ saveConflict }),
  setStatus: (status) => set({ status }),
  setWorkspace: (workspace) => set({ workspace }),
}));
