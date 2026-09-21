import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useUpdateCheck } from "../api/update-check.js";

const DISMISSED_KEY_PREFIX = "crewbench.update-banner.dismissed.";

/** A non-blocking "a newer version is available" banner (Phase 4
 * milestone 5, Design decision 7) -- never auto-updates, never blocks
 * anything, just informs. Dismissing it is per-viewer/per-version
 * (`localStorage`, the same "per-viewer convenience, wrapped in
 * try/catch" pattern `lib/notifications.ts` already established for its
 * own opt-in flag) -- keyed by the specific `latest` version so a
 * dismissal doesn't silently suppress a *later* release's own banner
 * too. Renders nothing at all when there's no real update, the check
 * hasn't loaded yet, or `current` couldn't be determined (this daemon's
 * own dev/unbundled case -- see `update-check.ts`'s own docstring; never
 * claiming an update when the daemon doesn't even know its own
 * version). */
export function UpdateBanner() {
  const { data } = useUpdateCheck();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  // Not a useState initializer: `data` is still undefined on this
  // component's first render (the query hasn't resolved yet), so reading
  // localStorage only at mount would always miss a real prior dismissal
  // -- re-checked here once `data.latest` is actually known.
  useEffect(() => {
    if (!data?.latest) return;
    try {
      setDismissedVersion(localStorage.getItem(DISMISSED_KEY_PREFIX + data.latest));
    } catch {
      // private window / blocked site data -- degrades to "not dismissed," not a crash
    }
  }, [data?.latest]);

  if (!data?.update_available || !data.latest || !data.current) return null;
  if (dismissedVersion === data.latest) return null;

  const dismiss = () => {
    setDismissedVersion(data.latest);
    try {
      localStorage.setItem(DISMISSED_KEY_PREFIX + (data.latest ?? ""), "1");
    } catch {
      // best-effort only -- the in-memory dismissedVersion state above still governs this session
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4 py-1.5 text-xs">
      <span>
        crewbench {data.latest} is available (you have {data.current}). Run <code>npm i -g crewbench</code> to update.
      </span>
      <button onClick={dismiss} aria-label="Dismiss" className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
        <X size={14} />
      </button>
    </div>
  );
}
