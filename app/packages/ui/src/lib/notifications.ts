import { useEffect, useRef, useState } from "react";
import type { ApiPendingApproval } from "@crewbench/contract";

const OPT_IN_KEY = "crewbench.notifications.optIn";

function hasNotificationApi(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Design decision 8: desktop notifications are client-side only,
 * opt-in, and driven purely off events the UI already receives over its
 * existing SSE connections -- no daemon-side push mechanism of any kind.
 * `pending` is `useApprovalsInbox()`'s own query data, already kept live
 * by the same `approval.*` events (see `api/approvals.ts`); this hook
 * adds no second subscription, it just watches that same list for ids
 * it hasn't fired a notification for yet. Opt-in state lives in
 * `localStorage` (a per-viewer convenience, not state anything else
 * needs to read back) -- wrapped in try/catch since a private window or
 * blocked site data can make it throw or return null, and the feature
 * degrades to "off" rather than crashing the page either way. */
export function useApprovalNotifications(pending: ApiPendingApproval[] | undefined): {
  supported: boolean;
  optedIn: boolean;
  permission: NotificationPermission | "unsupported";
  requestOptIn: () => Promise<void>;
} {
  const supported = hasNotificationApi();
  const [optedIn, setOptedIn] = useState(() => {
    if (!supported) return false;
    try {
      return localStorage.getItem(OPT_IN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");
  const seenIds = useRef<Set<string>>(new Set());
  const firstRun = useRef(true);

  useEffect(() => {
    if (!pending) return;
    // The first time this hook sees a list at all, seed `seenIds` without
    // notifying -- otherwise opening the app with approvals already
    // pending from before this session fires a notification for every
    // one of them at once, which is noise, not a real "this just
    // happened" signal.
    if (firstRun.current) {
      firstRun.current = false;
      for (const row of pending) seenIds.current.add(row.id);
      return;
    }
    if (!optedIn || !supported || Notification.permission !== "granted") {
      for (const row of pending) seenIds.current.add(row.id);
      return;
    }
    for (const row of pending) {
      if (seenIds.current.has(row.id)) continue;
      seenIds.current.add(row.id);
      try {
        new Notification("crewbench needs your approval", { body: `${row.title} -- ${row.kind}`, tag: row.id });
      } catch {
        // Notification construction can throw in some embedders -- never
        // let a notification failure break the inbox itself.
      }
    }
  }, [pending, optedIn, supported]);

  const requestOptIn = async (): Promise<void> => {
    if (!supported) return;
    const result = await Notification.requestPermission();
    setPermission(result);
    const granted = result === "granted";
    setOptedIn(granted);
    try {
      localStorage.setItem(OPT_IN_KEY, granted ? "1" : "0");
    } catch {
      // best-effort -- the in-memory optedIn state above still governs this session
    }
  };

  return { supported, optedIn, permission, requestOptIn };
}
