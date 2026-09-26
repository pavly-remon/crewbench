import { useState } from "react";
import { Copy, Play, RotateCcw, SquareTerminal, XCircle } from "lucide-react";
import type { ApiTaskDetail } from "@crewbench/contract";
import { Button } from "./button.js";
import { TerminalSessionDialog } from "./terminal-session.js";
import { useCancelTask, useResumeTask, useRetryRun } from "../api/tasks.js";
import { useCapabilities } from "../api/capabilities.js";

/** Copies `text` to the clipboard, best-effort -- the Clipboard API needs
 * a secure context and can throw (or simply not exist) in an embedded
 * webview or an insecure dev setup; this degrades to a silent no-op
 * (`ok: false`) rather than crashing the page over a convenience
 * feature. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyResumeCommand({ taskId, projectPath }: { taskId: string; projectPath: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const command = projectPath ? `cd ${projectPath} && crewbench resume ${taskId}` : `crewbench resume ${taskId}`;

  const onClick = () => {
    copyToClipboard(command)
      .then((ok) => {
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      })
      .catch(() => {});
  };

  return (
    <Button variant="ghost" onClick={onClick} title={command}>
      <Copy size={14} className="mr-1.5" />
      {copied ? "Copied!" : "Copy resume command"}
    </Button>
  );
}

/** "Open session" (Phase 4 milestone 3, Design decision 3): a real
 * embedded terminal running `crewbench resume <id>` in a live xterm.js
 * tab, gated on the *exact same* `canResume` condition the Resume button
 * above already uses -- not a re-derived approximation of it (finding
 * 7's own real hazard: opening a session against a task the daemon is
 * already actively driving would race a second `driveTask()` loop
 * against the first; `routes/pty.ts` enforces this server-side too, this
 * client-side check only avoids showing a button that would just fail).
 * Only rendered when `GET /api/capabilities` reports `pty: true` --
 * `node-pty` genuinely failed to install/load on this machine otherwise,
 * and `CopyResumeCommand` alone is shown instead, per Design decision
 * 3's own "fallback: node-pty unavailable -> ... not a broken button." */
function OpenSessionButton({ taskId, canResume }: { taskId: string; canResume: boolean }) {
  const [open, setOpen] = useState(false);
  if (!canResume) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <SquareTerminal size={14} className="mr-1.5" />
        Open session
      </Button>
      <TerminalSessionDialog open={open} onOpenChange={setOpen} taskId={taskId} />
    </>
  );
}

/** Task-level run controls (Phase 3 milestone 6, extended Phase 4
 * milestone 3): cancel (while the daemon is actively driving this task),
 * resume (once it's genuinely stopped -- a real `POST .../resume` call,
 * not just the clipboard fallback below), "Open session" (a real
 * embedded terminal, when `node-pty` is available on this machine), and
 * "copy resume command" -- a `crewbench resume <id>` one-liner for
 * running the exact same resume from a terminal instead, e.g. when the
 * daemon isn't running, `node-pty` isn't available, or the user wants to
 * watch it live outside the browser. The phase prompt's own UI bullet
 * names only "cancel, retry, copy resume command" for the agent lanes;
 * adding a real in-app Resume button here (not just the copy fallback)
 * is a disclosed interpretation -- the daemon route this milestone
 * builds would otherwise have no UI caller at all, which seemed like the
 * wrong call given every other milestone's own routes got a real UI
 * caller. */
export function TaskControls({ detail, projectPath }: { detail: ApiTaskDetail; projectPath: string | undefined }) {
  const cancel = useCancelTask(detail.id);
  const resume = useResumeTask(detail.id);
  const { data: capabilities } = useCapabilities();
  const canResume = !detail.active && (detail.phase === "stopped" || detail.phase === "failed");

  return (
    <div className="flex flex-wrap items-center gap-2">
      {detail.active && (
        <Button variant="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate(undefined)}>
          <XCircle size={14} className="mr-1.5" />
          {cancel.isPending ? "Cancelling…" : "Cancel"}
        </Button>
      )}
      {canResume && (
        <Button variant="primary" disabled={resume.isPending} onClick={() => resume.mutate()}>
          <Play size={14} className="mr-1.5" />
          {resume.isPending ? "Resuming…" : "Resume"}
        </Button>
      )}
      {capabilities?.pty && <OpenSessionButton taskId={detail.id} canResume={canResume} />}
      <CopyResumeCommand taskId={detail.id} projectPath={projectPath} />
      {cancel.isError && <p className="text-xs text-red-500">{cancel.error.message}</p>}
      {resume.isError && <p className="text-xs text-red-500">{resume.error.message}</p>}
    </div>
  );
}

/** Parses `developer-r3`/`gate-r1`/etc. into its role and round, or
 * `null` for a run name retry doesn't apply to (`ui-ux`, the one-time
 * design dispatch -- `ApiRetryRunRequestSchema`'s own regex already
 * excludes it, matched here so this component never even shows a button
 * that would just 400). */
function parseRun(run: string): { role: string; round: number } | null {
  const match = /^(developer|gate|tester|code-reviewer)-r(\d+)$/.exec(run);
  if (!match) return null;
  return { role: match[1] as string, round: Number(match[2]) };
}

/** Per-lane "Retry" control (Phase 3 milestone 6): only ever shown for a
 * run that's actually retryable right now -- `routes/task-control.ts`'s
 * own real constraint, matched here rather than shown-then-400'd: the
 * task's *current* round only (an earlier round's files being cleared
 * would silently desync replay, per that route's own docstring), and
 * only while the daemon isn't actively driving the task (retrying a live
 * run makes no sense -- there's nothing stopped to retry yet). */
export function RunLaneRetryButton({ taskId, run, detail }: { taskId: string; run: string; detail: ApiTaskDetail }) {
  const retry = useRetryRun(taskId);
  const parsed = parseRun(run);
  if (!parsed || detail.active || parsed.round !== detail.round) return null;

  return (
    <Button
      variant="ghost"
      className="h-6 px-2 text-xs"
      disabled={retry.isPending}
      onClick={() => retry.mutate(run)}
      title={`Retry ${run}`}
    >
      <RotateCcw size={12} className="mr-1" />
      {retry.isPending ? "Retrying…" : "Retry"}
    </Button>
  );
}
