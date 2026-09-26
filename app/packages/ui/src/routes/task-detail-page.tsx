import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { RoundsTimeline } from "../components/rounds-timeline.js";
import { IssuesTable } from "../components/issues-table.js";
import { FailuresTable } from "../components/failures-table.js";
import { DiffViewer } from "../components/diff-viewer.js";
import { SpecTab } from "../components/spec-tab.js";
import { ScreenshotsTab } from "../components/screenshots-tab.js";
import { WarningsBanner } from "../components/warnings-banner.js";
import { TaskControls, RunLaneRetryButton } from "../components/task-controls.js";
import { useTaskDetail, useTaskDiff, useTaskEvents } from "../api/task-detail.js";
import { useProjects } from "../api/projects.js";
import type { ApiTaskDetail } from "@crewbench/contract";

interface LaneEvent {
  seq: number;
  ts: string;
  type: string;
  text: string;
}

function summarizeEvent(event: { type: string; data: unknown; ts: string; seq: number }): string {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "run.started":
      return `started (${data.cli} · ${data.model} · ${data.effort})`;
    case "run.finished":
      return data.ok ? `finished ok in ${data.duration_s ?? "?"}s` : `finished with an error: ${data.error ?? "unknown"}`;
    case "run.message":
    case "run.tool_call":
    case "run.tool_error":
      return typeof data.text === "string" ? data.text : JSON.stringify(data);
    default:
      return event.type;
  }
}

function Header({ detail, projectPath }: { detail: NonNullable<ReturnType<typeof useTaskDetail>["data"]>; projectPath: string | undefined }) {
  const lineup = detail.lineup as Record<string, { cli?: string; model?: string; effort?: string; permissions?: string }>;
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{detail.title}</h1>
        <span className="rounded-full bg-[var(--color-bg-subtle)] px-2.5 py-1 text-xs font-medium">{detail.phase}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-fg-muted)]">
        <span>round {detail.round}</span>
        <span>branch {detail.branch ?? "(in-place)"}</span>
        <span>worktree {detail.worktree ?? "(none)"}</span>
        <span>base {detail.base_commit?.slice(0, 8) ?? "?"}</span>
        {detail.jira_key && <span>{detail.jira_key}</span>}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        {Object.entries(lineup).map(([role, r]) => (
          <span key={role} className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs">
            <span className="font-medium">{role}</span> {r.cli} · {r.model} · {r.effort} · {r.permissions}
          </span>
        ))}
      </div>
      {detail.stuck_reason && <p className="text-xs text-amber-500">stuck: {detail.stuck_reason}</p>}
      {detail.owner === "app" && Object.keys(detail.lineup).length > 0 && (
        <div className="pt-1">
          <TaskControls detail={detail} projectPath={projectPath} />
        </div>
      )}
    </Card>
  );
}

function AgentLanes({ lanes, taskId, detail }: { lanes: Record<string, LaneEvent[]>; taskId: string; detail: ApiTaskDetail }) {
  const runs = Object.keys(lanes).sort();
  if (runs.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No agent runs recorded yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {runs.map((run) => (
        <Card key={run} className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          <div className="sticky top-0 flex items-center justify-between bg-[var(--color-bg)] pb-1">
            <p className="text-sm font-medium">{run}</p>
            {detail.owner === "app" && <RunLaneRetryButton taskId={taskId} run={run} detail={detail} />}
          </div>
          {lanes[run]?.map((event) => (
            <p key={event.seq} className="text-xs text-[var(--color-fg-muted)]">
              <span className="text-[var(--color-fg)]">{event.type}</span> {event.text}
            </p>
          ))}
        </Card>
      ))}
    </div>
  );
}

/** Phase 3 milestone 4: an app-owned task with a finalized spec but no
 * lineup yet has been left mid-setup -- either the user closed the tab
 * right after finalizing scoping (before this milestone, there was
 * nowhere left to go from here; now there is), or they navigated back to
 * the board and clicked in from there instead of following the
 * scoping-chat page's own redirect. A task that hasn't even finished
 * scoping yet (`spec` still null) has no lineup-step link to offer --
 * resuming an abandoned scoping conversation isn't wired up this
 * milestone (a real, disclosed gap, not silently missing -- see this
 * milestone's own log). */
function LineupCta({ detail, taskId }: { detail: NonNullable<ReturnType<typeof useTaskDetail>["data"]>; taskId: string }) {
  if (detail.owner !== "app" || Object.keys(detail.lineup).length > 0) return null;
  return (
    <Card className="flex items-center justify-between border-[var(--color-accent)]">
      {detail.spec ? (
        <>
          <p className="text-sm">Spec finalized -- pick a lineup to start this task running.</p>
          <Link to="/tasks/$taskId/lineup" params={{ taskId }}>
            <Button variant="primary">Set up lineup</Button>
          </Link>
        </>
      ) : (
        <p className="text-sm text-[var(--color-fg-muted)]">Still being scoped -- no spec finalized yet.</p>
      )}
    </Card>
  );
}

const TABS = ["Rounds & lanes", "Issues", "Failures", "Diff", "Spec", "Screenshots"] as const;
type Tab = (typeof TABS)[number];

function DiffTab({ taskId, round }: { taskId: string; round: number }) {
  const [mode, setMode] = useState<"base" | number>("base");
  const { data, isLoading } = useTaskDiff(taskId, mode);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 text-xs">
        <button
          onClick={() => setMode("base")}
          className={mode === "base" ? "font-semibold text-[var(--color-accent)]" : "text-[var(--color-fg-muted)]"}
        >
          vs base
        </button>
        {round > 0 && (
          <button
            onClick={() => setMode(round)}
            className={mode === round ? "font-semibold text-[var(--color-accent)]" : "text-[var(--color-fg-muted)]"}
          >
            round {round} delta
          </button>
        )}
      </div>
      {isLoading ? <p className="text-sm text-[var(--color-fg-muted)]">Loading diff…</p> : <DiffViewer diff={data?.diff ?? ""} />}
    </div>
  );
}

export function TaskDetailPage() {
  const { taskId } = useParams({ from: "/tasks/$taskId" });
  const { data: detail, isLoading, isError, error } = useTaskDetail(taskId);
  const { data: projects } = useProjects();
  const [lanes, setLanes] = useState<Record<string, LaneEvent[]>>({});
  const [tab, setTab] = useState<Tab>("Rounds & lanes");

  useTaskEvents(taskId, (event) => {
    if (!event.run) return;
    setLanes((prev) => {
      const existing = prev[event.run as string] ?? [];
      if (existing.some((e) => e.seq === event.seq)) return prev;
      const next = [...existing, { seq: event.seq, ts: event.ts, type: event.type, text: summarizeEvent(event) }];
      return { ...prev, [event.run as string]: next };
    });
  });

  if (isLoading) return <p className="text-sm text-[var(--color-fg-muted)]">Loading task…</p>;
  if (isError) return <p className="text-sm text-red-500">{error.message}</p>;
  if (!detail || !taskId) return null;

  const screenshots = detail.rounds.flatMap((r) => r.tester?.screenshots ?? []);
  const projectPath = projects?.find((p) => p.id === detail.project_id)?.path;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <Header detail={detail} projectPath={projectPath} />
      <LineupCta detail={detail} taskId={taskId} />
      <WarningsBanner warnings={detail.warnings} />

      <div className="flex gap-4 border-b border-[var(--color-border)] text-sm">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 pb-2 ${t === tab ? "border-[var(--color-accent)] font-medium" : "border-transparent text-[var(--color-fg-muted)]"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Rounds & lanes" && (
        <>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Rounds</h2>
            <RoundsTimeline rounds={detail.rounds} />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Agent lanes</h2>
            <AgentLanes lanes={lanes} taskId={taskId} detail={detail} />
          </section>
        </>
      )}
      {tab === "Issues" && <IssuesTable issues={detail.issues} />}
      {tab === "Failures" && <FailuresTable rounds={detail.rounds} />}
      {tab === "Diff" && <DiffTab taskId={taskId} round={detail.round} />}
      {tab === "Spec" && <SpecTab spec={detail.spec} />}
      {tab === "Screenshots" && <ScreenshotsTab taskId={taskId} screenshots={screenshots} />}
    </div>
  );
}
