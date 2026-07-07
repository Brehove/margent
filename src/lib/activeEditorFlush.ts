export type ActiveEditorFlushResult =
  | "blocked"
  | "conflict"
  | "error"
  | "idle"
  | "saved";

interface ActiveEditorFlushProvider {
  flush: () => Promise<ActiveEditorFlushResult>;
  getContent: () => string;
  isDirty: () => boolean;
}

let activeProvider: ActiveEditorFlushProvider | null = null;

export function registerActiveEditorFlushProvider(
  provider: ActiveEditorFlushProvider,
) {
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) {
      activeProvider = null;
    }
  };
}

export async function flushActiveEditorDraft() {
  const provider = activeProvider;
  if (!provider || !provider.isDirty()) {
    return "idle" satisfies ActiveEditorFlushResult;
  }

  return provider.flush();
}

export function getActiveEditorDraftContent() {
  return activeProvider?.getContent() ?? null;
}
