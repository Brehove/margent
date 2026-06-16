import {
  convertFileSrc as tauriConvertFileSrc,
  invoke as tauriInvoke,
  isTauri,
} from "@tauri-apps/api/core";
import { listen as tauriListen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { open as tauriOpen, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import { watch as tauriWatch, type WatchEvent } from "@tauri-apps/plugin-fs";
import type { ProposalMutationResult } from "../types/proposal";
import type { ProjectSearchMode, ProjectSearchResponse } from "../types/search";
import type { ThreadRecord } from "../types/thread";
import type { DocumentPayload, DocumentSummary, WorkspaceSnapshot } from "../types/workspace";

type InvokeArgs = Record<string, unknown> | undefined;
type Unlisten = () => void;
export type { WatchEvent };

interface ServedWorkspaceResponse {
  rootPath: string;
  mdreviewPath: string;
  documents: DocumentSummary[];
}

interface ServedDocumentResponse {
  document: DocumentSummary;
  content: string;
}

export function isDesktopBackend() {
  return isTauri();
}

export function convertLocalFileSrc(path: string) {
  return isTauri() ? tauriConvertFileSrc(path) : path;
}

export async function invokeBackend<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(command, args);
  }

  return webInvoke<T>(command, args);
}

export async function listenBackend<T>(
  event: string,
  handler: (event: TauriEvent<T>) => void,
): Promise<Unlisten> {
  if (isTauri()) {
    return tauriListen<T>(event, handler);
  }

  return () => {};
}

export async function watchBackend(
  path: string,
  handler: (event: WatchEvent) => void,
  options?: Parameters<typeof tauriWatch>[2],
): Promise<Unlisten> {
  if (isTauri()) {
    return tauriWatch(path, handler, options);
  }

  const socket = openServeSocket(() => handler({ paths: [], type: "any" } as unknown as WatchEvent));
  return () => socket?.close();
}

export async function openBackend(options?: OpenDialogOptions) {
  if (isTauri()) {
    return tauriOpen(options);
  }

  return null;
}

async function webInvoke<T>(command: string, args: InvokeArgs): Promise<T> {
  switch (command) {
    case "open_workspace":
      return servedWorkspaceSnapshot() as Promise<T>;
    case "list_review_passes":
      return servedJson<T>("/api/review-passes");
    case "read_document":
      return servedDocumentByRelativePath(requiredString(args, "relativePath")) as Promise<T>;
    case "check_document_update":
      return servedDocumentByRelativePath(requiredString(args, "relativePath")) as Promise<T>;
    case "search_workspace":
      return servedProjectSearch(args) as Promise<T>;
    case "load_threads":
      return servedJson<T>(`/api/threads?documentId=${encodeURIComponent(requiredString(args, "documentId"))}`);
    case "load_all_threads":
      return servedJson<T>("/api/threads");
    case "load_thread":
      return servedThread(requiredString(args, "threadId")) as Promise<T>;
    case "check_thread_update_signature":
      return Promise.resolve(String(Date.now())) as Promise<T>;
    case "add_thread_message":
      return servedJson<T>(`/api/threads/${encodeURIComponent(requiredString(args, "threadId"))}/reply`, {
        body: JSON.stringify({
          body: requiredString(args, "body"),
          kind: typeof args?.kind === "string" ? args.kind : "reply",
        }),
        method: "POST",
      });
    case "resolve_thread":
      return servedJson<T>(`/api/threads/${encodeURIComponent(requiredString(args, "threadId"))}/resolve`, {
        method: "POST",
      });
    case "reopen_thread":
      return servedJson<T>(`/api/threads/${encodeURIComponent(requiredString(args, "threadId"))}/reopen`, {
        method: "POST",
      });
    case "load_proposals":
      return servedJson<T>(`/api/proposals?documentId=${encodeURIComponent(requiredString(args, "documentId"))}`);
    case "load_all_proposals":
      return servedJson<T>("/api/proposals");
    case "accept_proposal":
      return servedJson<ProposalMutationResult>(
        `/api/proposals/${encodeURIComponent(requiredString(args, "proposalId"))}/accept`,
        {
          body: JSON.stringify({
            updatedDocumentText:
              typeof args?.updatedDocumentText === "string"
                ? args.updatedDocumentText
                : undefined,
          }),
          method: "POST",
        },
      ) as Promise<T>;
    case "reject_proposal":
      return servedJson<ProposalMutationResult>(
        `/api/proposals/${encodeURIComponent(requiredString(args, "proposalId"))}/reject`,
        { method: "POST" },
      ) as Promise<T>;
    default:
      throw new Error(`${command} is only available in the Margent desktop app.`);
  }
}

async function servedProjectSearch(args: InvokeArgs): Promise<ProjectSearchResponse> {
  const query = requiredString(args, "query").trim();
  const mode = parseProjectSearchMode(args);
  const caseSensitive = Boolean(args?.caseSensitive);
  const workspace = await servedJson<ServedWorkspaceResponse>("/api/workspace");
  if (!query) {
    return {
      caseSensitive,
      mode,
      query,
      results: [],
      searchedFiles: 0,
      truncated: false,
    };
  }

  const matcher = buildProjectSearchMatcher(query, mode, caseSensitive);
  const results: ProjectSearchResponse["results"] = [];
  let truncated = false;

  for (const document of workspace.documents) {
    const payload = await servedJson<ServedDocumentResponse>(
      `/api/documents/${encodeURIComponent(document.id)}`,
    );
    const lines = payload.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const lineText = lines[lineIndex] ?? "";
      matcher.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(lineText)) !== null) {
        if (match[0].length === 0) {
          matcher.lastIndex += 1;
          continue;
        }
        if (results.length >= 500) {
          truncated = true;
          return {
            caseSensitive,
            mode,
            query,
            results,
            searchedFiles: workspace.documents.length,
            truncated,
          };
        }
        const startColumn = Array.from(lineText.slice(0, match.index)).length + 1;
        const endColumn = startColumn + Array.from(match[0]).length;
        results.push({
          afterContext: lines[lineIndex + 1] ?? null,
          beforeContext: lineIndex > 0 ? lines[lineIndex - 1] : null,
          column: startColumn,
          displayName: document.displayName,
          documentId: document.id,
          line: lineIndex + 1,
          lineText,
          matchEndColumn: endColumn,
          matchStartColumn: startColumn,
          matchText: match[0],
          relativePath: document.relativePath,
        });
      }
    }
  }

  return {
    caseSensitive,
    mode,
    query,
    results,
    searchedFiles: workspace.documents.length,
    truncated,
  };
}

function parseProjectSearchMode(args: InvokeArgs): ProjectSearchMode {
  return args?.mode === "regex" ? "regex" : "literal";
}

function buildProjectSearchMatcher(query: string, mode: ProjectSearchMode, caseSensitive: boolean) {
  const pattern = mode === "literal" ? escapeRegExp(query) : query;
  try {
    return new RegExp(pattern, `g${caseSensitive ? "" : "i"}`);
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Invalid regular expression: ${error.message}` : "Invalid regular expression.",
    );
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function servedWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const workspace = await servedJson<ServedWorkspaceResponse>("/api/workspace");
  return {
    documents: workspace.documents,
    mdreviewPath: workspace.mdreviewPath,
    openedPath: workspace.rootPath,
    rootPath: workspace.rootPath,
    selectedRelativePath: workspace.documents[0]?.relativePath ?? null,
  };
}

async function servedDocumentByRelativePath(relativePath: string): Promise<DocumentPayload | null> {
  const workspace = await servedJson<ServedWorkspaceResponse>("/api/workspace");
  const document = workspace.documents.find((entry) => entry.relativePath === relativePath);
  if (!document) {
    return null;
  }

  const payload = await servedJson<ServedDocumentResponse>(
    `/api/documents/${encodeURIComponent(document.id)}`,
  );
  return {
    ...payload.document,
    absolutePath: payload.document.relativePath,
    content: payload.content,
  };
}

async function servedThread(threadId: string): Promise<ThreadRecord> {
  const workspace = await servedJson<ServedWorkspaceResponse>("/api/workspace");
  for (const document of workspace.documents) {
    const threads = await servedJson<ThreadRecord[]>(
      `/api/threads?documentId=${encodeURIComponent(document.id)}`,
    );
    const thread = threads.find((entry) => entry.id === threadId);
    if (thread) {
      return thread;
    }
  }

  throw new Error(`Thread ${threadId} was not found.`);
}

async function servedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${serveToken()}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : response.statusText);
  }
  return body as T;
}

function openServeSocket(onRefresh: () => void) {
  const token = serveToken();
  if (!token || typeof WebSocket === "undefined") {
    return null;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.addEventListener("message", onRefresh);
  return socket;
}

function serveToken() {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

function requiredString(args: InvokeArgs, key: string) {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}
