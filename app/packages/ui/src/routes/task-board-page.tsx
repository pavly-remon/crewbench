import { Link, useParams } from "@tanstack/react-router";
import { TASK_PHASES, type ApiTaskSummary, type TaskPhase } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { useProjectTasks } from "../api/projects.js";
import { useGlobalEvents } from "../api/events.js";

const PHASE_LABELS: Record<TaskPhase, string> = {
  scoping: "Scoping",
  design: "Design",
  implementing: "Implementing",
  verifying: "Verifying",
  fixing: "Fixing",
  awaiting_commit: "Awaiting commit",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

function elapsedSince(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function TaskCard({ task, queued }: { task: ApiTaskSummary; queued: boolean }) {
  return (
    <Link to="/tasks/$taskId" params={{ taskId: task.id }}>
      <Card className="flex flex-col gap-1.5 p-3 hover:border-[var(--color-accent)]">
        <p className="text-sm font-medium">{task.title ?? task.id}</p>
        <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
          <span>round {task.round ?? 0}</span>
          {queued ? (
            <span className="flex items-center gap-1 text-amber-500">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              queued
            </span>
          ) : (
            <span>{elapsedSince(task.updated_at)}</span>
          )}
        </div>
      </Card>
    </Link>
  );
}

export function TaskBoardPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: tasks, isLoading, isError, error } = useProjectTasks(projectId);
  const queuedTaskIds = useGlobalEvents();

  const byPhase = new Map<string, ApiTaskSummary[]>();
  for (const task of tasks ?? []) {
    const phase = task.phase ?? "scoping";
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push(task);
  }

  if (isLoading) return <p className="text-sm text-[var(--color-fg-muted)]">Loading tasks…</p>;
  if (isError) return <p className="text-sm text-red-500">{error.message}</p>;

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {TASK_PHASES.map((phase) => (
        <div key={phase} className="flex w-64 shrink-0 flex-col gap-2">
          <h2 className="px-1 text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">
            {PHASE_LABELS[phase]} <span className="ml-1 opacity-60">{byPhase.get(phase)?.length ?? 0}</span>
          </h2>
          <div className="flex flex-col gap-2">
            {(byPhase.get(phase) ?? []).map((task) => (
              <TaskCard key={task.id} task={task} queued={queuedTaskIds.has(task.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
