import { BaseDirectory } from "@tauri-apps/plugin-fs";

export interface WatchTarget {
  path: string;
  options: {
    baseDir?: BaseDirectory;
    delayMs?: number;
    recursive?: boolean;
  };
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

function trimTrailingSlash(path: string) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function getParentDirectoryPath(path: string) {
  const normalized = trimTrailingSlash(normalizePath(path));
  const lastSlashIndex = normalized.lastIndexOf("/");

  if (lastSlashIndex <= 0) {
    return normalized;
  }

  return normalized.slice(0, lastSlashIndex);
}

export function getScopedWatchTarget(path: string, options: WatchTarget["options"] = {}): WatchTarget {
  const normalized = trimTrailingSlash(normalizePath(path));
  const homeMatch = normalized.match(/^\/Users\/[^/]+\/(.+)$/);

  if (homeMatch?.[1]) {
    return {
      path: homeMatch[1],
      options: {
        ...options,
        baseDir: BaseDirectory.Home,
      },
    };
  }

  return {
    path,
    options,
  };
}
