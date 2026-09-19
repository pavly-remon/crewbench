import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Card } from "../components/card.js";
import { useTaskDetail, useTaskEvents } from "../api/task-detail.js";

interface RoundRecordLike {
  round: number;
  gate: { ok: boolean } | null;
  tester: { verdict: string } | null;
  reviewer: { verdict: string } | null;
}

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

function Header({ detail }: { detail: NonNullable<ReturnType<typeof useTaskDetail>["data"]> }) {
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
    </Card>
  );
}

function RoundsTimeline({ rounds }: { rounds: unknown[] }) {
  const typed = rounds as RoundRecordLike[];
  if (typed.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No completed rounds yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {typed.map((round) => (
        <Card key={round.round} className="flex items-center gap-4 text-sm">
          <span className="font-medium">round {round.round}</span>
          <span className={round.gate?.ok === false ? "text-red-500" : "text-[var(--color-fg-muted)]"}>
            gate: {round.gate === null ? "skipped" : round.gate.ok ? "ok" : "failed"}
          </span>
          {round.tester && <span>tester: {round.tester.verdict}</span>}
          {round.reviewer && <span>reviewer: {round.reviewer.verdict}</span>}
        </Card>
      ))}
    </div>
  );
}

function AgentLanes({ lanes }: { lanes: Record<string, LaneEvent[]> }) {
  const runs = Object.keys(lanes).sort();
  if (runs.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No agent runs recorded yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {runs.map((run) => (
        <Card key={run} className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          <p className="sticky top-0 bg-[var(--color-bg)] pb-1 text-sm font-medium">{run}</p>
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

export function TaskDetailPage() {
  const { taskId } = useParams({ from: "/tasks/$taskId" });
  const { data: detail, isLoading, isError, error } = useTaskDetail(taskId);
  const [lanes, setLanes] = useState<Record<string, LaneEvent[]>>({});

  useTaskEvents(taskId, (event) => {
    if (!event.run) return;
    setLanes((prev) => {
      const existing = prev[event.run as string] ?? [];
      if (existing.some((e) => e.seq === event.seq)) return prev;
      const next = [...existing, { seq: event.seq, ts: event.ts, type: event.type, text: summarizeEvent(event) }];
      return { ...prev, [event.run as string]: next };
    });
  });

  const rounds = useMemo(() => detail?.rounds ?? [], [detail]);

  if (isLoading) return <p className="text-sm text-[var(--color-fg-muted)]">Loading task…</p>;
  if (isError) return <p className="text-sm text-red-500">{error.message}</p>;
  if (!detail) return null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <Header detail={detail} />
      <section>
        <h2 className="mb-2 text-sm font-semibold">Rounds</h2>
        <RoundsTimeline rounds={rounds} />
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Agent lanes</h2>
        <AgentLanes lanes={lanes} />
      </section>
    </div>
  );
}
