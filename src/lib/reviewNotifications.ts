import { isDesktopBackend } from "./backend";
import type { ThreadRecord } from "../types/thread";

interface ReviewNotificationTarget {
  documentRelativePath: string;
  threadId: string;
  workspaceRoot: string;
}

export interface ReviewNotificationItem extends ReviewNotificationTarget {
  body: string;
  title: string;
}

let unreadReviewNotificationCount = 0;
let onOpenTarget: ((target: ReviewNotificationTarget) => void) | null = null;
let notificationActionSetup: Promise<void> | null = null;
const notificationTargets = new Map<number, ReviewNotificationTarget>();

export function collectReviewNotificationItems({
  documentRelativePath,
  nextThreads,
  previousThreads,
  workspaceRoot,
}: {
  documentRelativePath: string;
  nextThreads: ThreadRecord[];
  previousThreads: ThreadRecord[];
  workspaceRoot: string;
}): ReviewNotificationItem[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread]));
  const items: ReviewNotificationItem[] = [];

  for (const nextThread of nextThreads) {
    const previousThread = previousById.get(nextThread.id);
    const previousMessageIds = new Set(previousThread?.messages.map((message) => message.id) ?? []);
    const previousProposalIds = new Set(previousThread?.linkedProposalIds ?? []);

    for (const message of nextThread.messages) {
      if (previousMessageIds.has(message.id) || !isAgentNotificationMessage(message.authorType)) {
        continue;
      }

      items.push({
        body: notificationBody(message.body),
        documentRelativePath,
        threadId: nextThread.id,
        title: `${message.authorName || "Agent"} replied: ${nextThread.title}`,
        workspaceRoot,
      });
    }

    for (const proposalId of nextThread.linkedProposalIds) {
      if (previousProposalIds.has(proposalId)) {
        continue;
      }

      items.push({
        body: `New proposal ${proposalId}`,
        documentRelativePath,
        threadId: nextThread.id,
        title: `Revision proposal: ${nextThread.title}`,
        workspaceRoot,
      });
    }
  }

  return items;
}

export function setReviewNotificationOpenHandler(
  handler: (target: ReviewNotificationTarget) => void,
) {
  onOpenTarget = handler;
  void ensureNotificationActionListener();

  return () => {
    if (onOpenTarget === handler) {
      onOpenTarget = null;
    }
  };
}

export async function notifyReviewUpdates(items: ReviewNotificationItem[]) {
  if (!items.length || !isDesktopBackend() || !isAppUnfocused()) {
    return;
  }

  try {
    const canNotify = await ensureNotificationPermission();
    if (!canNotify) {
      return;
    }

    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    await ensureNotificationActionListener();

    for (const item of items) {
      const id = notificationId(item);
      notificationTargets.set(id, item);
      sendNotification({
        autoCancel: true,
        body: item.body,
        extra: {
          documentRelativePath: item.documentRelativePath,
          threadId: item.threadId,
          workspaceRoot: item.workspaceRoot,
        },
        group: "margent-review-updates",
        id,
        title: item.title,
      });
    }

    unreadReviewNotificationCount += items.length;
    await setDockBadgeCount(unreadReviewNotificationCount);
  } catch {
    // Notification delivery should never break thread refresh.
  }
}

export async function clearReviewNotificationBadge() {
  unreadReviewNotificationCount = 0;
  notificationTargets.clear();
  await setDockBadgeCount(0);
}

function isAgentNotificationMessage(authorType: string) {
  return authorType === "agent" || authorType === "assistant" || authorType === "system";
}

function notificationBody(body: string) {
  const trimmed = body.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "New agent activity";
  }

  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

function isAppUnfocused() {
  return document.visibilityState !== "visible" || !document.hasFocus();
}

async function ensureNotificationPermission() {
  const { isPermissionGranted, requestPermission } = await import(
    "@tauri-apps/plugin-notification"
  );

  if (await isPermissionGranted()) {
    return true;
  }

  return (await requestPermission()) === "granted";
}

async function ensureNotificationActionListener() {
  if (notificationActionSetup) {
    return notificationActionSetup;
  }

  notificationActionSetup = import("@tauri-apps/plugin-notification")
    .then(({ onAction }) =>
      onAction((notification) => {
        const target = notificationTargetFromPayload(notification);
        if (!target) {
          return;
        }

        void clearReviewNotificationBadge();
        void focusCurrentWindow();
        onOpenTarget?.(target);
      }),
    )
    .then(() => undefined)
    .catch(() => undefined);

  return notificationActionSetup;
}

function notificationTargetFromPayload(notification: {
  extra?: Record<string, unknown>;
  id?: number;
}): ReviewNotificationTarget | null {
  const extraTarget = targetFromExtra(notification.extra);
  if (extraTarget) {
    return extraTarget;
  }

  if (typeof notification.id === "number") {
    return notificationTargets.get(notification.id) ?? null;
  }

  return null;
}

function targetFromExtra(extra: Record<string, unknown> | undefined) {
  if (
    !extra ||
    typeof extra.documentRelativePath !== "string" ||
    typeof extra.threadId !== "string" ||
    typeof extra.workspaceRoot !== "string"
  ) {
    return null;
  }

  return {
    documentRelativePath: extra.documentRelativePath,
    threadId: extra.threadId,
    workspaceRoot: extra.workspaceRoot,
  };
}

function notificationId(item: ReviewNotificationItem) {
  let hash = 0;
  const value = `${item.workspaceRoot}\0${item.documentRelativePath}\0${item.threadId}\0${item.title}\0${Date.now()}`;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash & 0x7fffffff;
}

async function setDockBadgeCount(count: number) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    await currentWindow.setBadgeCount(count > 0 ? count : undefined);
    await currentWindow.setBadgeLabel(count > 0 ? String(count) : undefined);
  } catch {
    // Some platforms or test environments do not support badges.
  }
}

async function focusCurrentWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    await currentWindow.unminimize();
    await currentWindow.show();
    await currentWindow.setFocus();
  } catch {
    // Best effort: selecting the thread still works when the window API rejects.
  }
}
