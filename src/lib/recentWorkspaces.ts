import type { WorkspaceSnapshot } from "../types/workspace";

export interface RecentWorkspaceEntry {
  activeRelativePath: string | null;
  label: string;
  openedPath: string | null;
  rootPath: string;
  updatedAt: string;
}

const RECENT_WORKSPACES_STORAGE_KEY = "margent:recent-workspaces";
const MAX_RECENT_WORKSPACES = 5;

export function readRecentWorkspaces(): RecentWorkspaceEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(RECENT_WORKSPACES_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isRecentWorkspaceEntry).slice(0, MAX_RECENT_WORKSPACES);
  } catch {
    return [];
  }
}

export function rememberRecentWorkspace(
  workspace: WorkspaceSnapshot,
  activeRelativePath: string | null,
) {
  if (typeof window === "undefined") {
    return;
  }

  const entry: RecentWorkspaceEntry = {
    activeRelativePath,
    label: getLastPathSegment(workspace.rootPath),
    openedPath: workspace.openedPath,
    rootPath: workspace.rootPath,
    updatedAt: new Date().toISOString(),
  };
  const nextEntries = [
    entry,
    ...readRecentWorkspaces().filter((recent) => recent.rootPath !== workspace.rootPath),
  ].slice(0, MAX_RECENT_WORKSPACES);

  window.localStorage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(nextEntries));
}

export function forgetRecentWorkspace(rootPath: string) {
  if (typeof window === "undefined") {
    return;
  }

  const nextEntries = readRecentWorkspaces().filter((recent) => recent.rootPath !== rootPath);
  if (nextEntries.length) {
    window.localStorage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(nextEntries));
    return;
  }

  window.localStorage.removeItem(RECENT_WORKSPACES_STORAGE_KEY);
}

function isRecentWorkspaceEntry(value: unknown): value is RecentWorkspaceEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<RecentWorkspaceEntry>;
  return (
    typeof entry.rootPath === "string" &&
    typeof entry.label === "string" &&
    typeof entry.updatedAt === "string" &&
    (entry.openedPath === null || typeof entry.openedPath === "string") &&
    (entry.activeRelativePath === null || typeof entry.activeRelativePath === "string")
  );
}

function getLastPathSegment(path: string) {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
