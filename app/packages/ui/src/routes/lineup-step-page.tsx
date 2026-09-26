import { useEffect, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { RoleKey } from "@crewbench/contract";
import { ROLE_KEYS } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { RoleLineupEditor } from "../components/role-lineup-editor.js";
import { useTaskDetail } from "../api/task-detail.js";
import { useTeam } from "../api/team.js";
import { useDoctor } from "../api/doctor.js";
import { useSubmitLineup } from "../api/tasks.js";
import { suggestLineup, type LineupRoleValue } from "../lib/lineup-defaults.js";

/** The lineup step (Phase 3 milestone 4): the real hand-off milestone
 * 3's scoping-chat CLI/model picker was always a stand-in for (see that
 * milestone's own log). Reached after a spec is finalized
 * (`scoping-chat-page.tsx` now navigates here instead of straight to
 * task detail), and also linkable directly from task detail for a task
 * that was left here mid-setup (`task-detail-page.tsx`'s own "set up
 * lineup" banner). */
export function LineupStepPage() {
  const { taskId } = useParams({ from: "/tasks/$taskId/lineup" });
  const navigate = useNavigate();
  const { data: detail, isLoading: detailLoading } = useTaskDetail(taskId);
  const { data: team } = useTeam(detail?.project_id);
  const { data: doctor } = useDoctor();
  const submit = useSubmitLineup(taskId);

  const [roles, setRoles] = useState<Record<RoleKey, LineupRoleValue> | null>(null);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const seeded = detail !== undefined && team !== undefined;

  useEffect(() => {
    if (seeded && roles === null) setRoles(suggestLineup(team));
    // Only seed once, the first time both loads land -- re-running this
    // on every `team`/`detail` refetch would stomp the user's own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded]);

  if (detailLoading || !detail) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }
  if (detail.owner !== "app") {
    return <p className="text-sm text-red-500">This task isn't owned by the app -- it can't be started from here.</p>;
  }
  if (!detail.spec) {
    return <p className="text-sm text-[var(--color-fg-muted)]">This task's scoping conversation hasn't produced a spec yet.</p>;
  }
  if (Object.keys(detail.lineup).length > 0) {
    // Already started (a one-shot action, per routes/lineup.ts) --
    // nothing to confirm here anymore.
    navigate({ to: "/tasks/$taskId", params: { taskId } }).catch(() => {});
    return null;
  }
  if (!roles) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }

  const onSubmit = () => {
    submit.mutate(
      { roles, save_as_default: saveAsDefault },
      {
        onSuccess: () => {
          navigate({ to: "/tasks/$taskId", params: { taskId } }).catch(() => {});
        },
      },
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card className="flex flex-col gap-1">
        <h1 className="text-sm font-semibold">Lineup: {detail.title}</h1>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Pick who does what, then confirm to start. Suggested from this project's team defaults, if any -- edit anything below.
        </p>
      </Card>

      <Card>
        <RoleLineupEditor
          roles={roles}
          team={team}
          doctorReports={doctor?.reports}
          onChange={(role, next) => setRoles((prev) => (prev ? { ...prev, [role]: next } : prev))}
        />
      </Card>

      <Card className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={saveAsDefault} onChange={(e) => setSaveAsDefault(e.target.checked)} />
          Save as this project's default team
        </label>
        <Button variant="primary" onClick={onSubmit} disabled={submit.isPending || !ROLE_KEYS.every((r) => roles[r]?.model.trim())}>
          {submit.isPending ? "Starting…" : "Confirm and start"}
        </Button>
      </Card>
      {submit.isError && <p className="text-sm text-red-500">{submit.error.message}</p>}
    </div>
  );
}
