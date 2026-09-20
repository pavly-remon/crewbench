import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { TASK_PHASES, type ApiTaskSummary, type TaskPhase } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { Dialog } from "../components/dialog.js";
import { useProjectTasks } from "../api/projects.js";
import { useGlobalEvents } from "../api/events.js";
import { useCreateTask } from "../api/tasks.js";

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

function NewTaskDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [taskText, setTaskText] = useState("");
  const [jiraKey, setJiraKey] = useState("");
  const createTask = useCreateTask(projectId);
  const navigate = useNavigate();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    createTask.mutate(
      { task_text: taskText, jira_key: jiraKey || undefined },
      {
        onSuccess: (detail) => {
          onOpenChange(false);
          setTaskText("");
          setJiraKey("");
          navigate({ to: "/tasks/$taskId/scoping", params: { taskId: detail.id }, search: { text: taskText } }).catch(() => {});
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New task">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Task description
          <textarea
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            placeholder="Describe what needs to be done…"
            rows={4}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Jira key (optional)
          <input
            value={jiraKey}
            onChange={(e) => setJiraKey(e.target.value)}
            placeholder="PROJ-123"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
        </label>
        {createTask.isError && <p className="text-sm text-red-500">{createTask.error.message}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={createTask.isPending}>
            {createTask.isPending ? "Creating…" : "Create & scope"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function TaskBoardPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: tasks, isLoading, isError, error } = useProjectTasks(projectId);
  const queuedTaskIds = useGlobalEvents();
  const [dialogOpen, setDialogOpen] = useState(false);

  const byPhase = new Map<string, ApiTaskSummary[]>();
  for (const task of tasks ?? []) {
    const phase = task.phase ?? "scoping";
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push(task);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setDialogOpen(true)}>
          <Plus size={16} className="mr-1.5" />
          New task
        </Button>
      </div>

      {isLoading && <p className="text-sm text-[var(--color-fg-muted)]">Loading tasks…</p>}
      {isError && <p className="text-sm text-red-500">{error.message}</p>}

      {!isLoading && !isError && (
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
      )}

      {projectId && <NewTaskDialog projectId={projectId} open={dialogOpen} onOpenChange={setDialogOpen} />}
    </div>
  );
}
