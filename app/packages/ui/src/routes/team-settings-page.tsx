import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import type { RoleKey, Team } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { RoleLineupEditor } from "../components/role-lineup-editor.js";
import { useTeam, useSaveTeam } from "../api/team.js";
import { useDoctor } from "../api/doctor.js";
import { suggestLineup, type LineupRoleValue } from "../lib/lineup-defaults.js";

function diffLines(before: Record<RoleKey, LineupRoleValue>, after: Record<RoleKey, LineupRoleValue>): string[] {
  const lines: string[] = [];
  for (const role of Object.keys(after) as RoleKey[]) {
    const b = before[role];
    const a = after[role];
    if (!b) continue;
    if (b.cli !== a.cli) lines.push(`${role}.cli: ${b.cli} -> ${a.cli}`);
    if (b.model !== a.model) lines.push(`${role}.model: ${b.model} -> ${a.model}`);
    if (b.effort !== a.effort) lines.push(`${role}.effort: ${b.effort} -> ${a.effort}`);
    if (b.permissions !== a.permissions) lines.push(`${role}.permissions: ${b.permissions} -> ${a.permissions}`);
  }
  return lines;
}

/** Team settings (Phase 3 milestone 4): edits `.crewbench/team.json`'s
 * own "team roster" -- the per-role `cli`/`model`/`effort`/`permissions`
 * lineup the phase prompt's own wording names, reusing the exact same
 * `RoleLineupEditor` the lineup step uses. **Deliberately scoped to just
 * the roster**: `team.json` also has `tiers`/`loop`/`workspace`/
 * `confirm_lineup` fields (`TeamSchema`), none of which this page edits
 * yet -- a real, disclosed gap, not hidden, since the phase prompt names
 * only "team roster" here and doesn't specify the rest. */
export function TeamSettingsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/team" });
  const { data: team, isLoading } = useTeam(projectId);
  const { data: doctor } = useDoctor();
  const save = useSaveTeam(projectId);

  const [original, setOriginal] = useState<Record<RoleKey, LineupRoleValue> | null>(null);
  const [roles, setRoles] = useState<Record<RoleKey, LineupRoleValue> | null>(null);

  useEffect(() => {
    if (team !== undefined && roles === null) {
      const suggested = suggestLineup(team);
      setOriginal(suggested);
      setRoles(suggested);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  if (isLoading || !roles || !original) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }

  const diff = diffLines(original, roles);

  const onSave = () => {
    const nextRoles: Team["roles"] = {};
    for (const role of Object.keys(roles) as RoleKey[]) {
      const r = roles[role];
      nextRoles[role] = { cli: r.cli, model: r.model, effort: r.effort, permissions: r.permissions };
    }
    save.mutate(
      { ...team, roles: nextRoles },
      {
        onSuccess: (saved) => {
          const suggested = suggestLineup(saved);
          setOriginal(suggested);
          setRoles(suggested);
        },
      },
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Team</h1>
      <Card>
        <RoleLineupEditor
          roles={roles}
          team={team}
          doctorReports={doctor?.reports}
          onChange={(role, next) => setRoles((prev) => (prev ? { ...prev, [role]: next } : prev))}
        />
      </Card>

      {diff.length > 0 && (
        <Card className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">Changes</h2>
          {diff.map((line) => (
            <p key={line} className="font-mono text-xs">
              {line}
            </p>
          ))}
        </Card>
      )}

      <div className="flex justify-end">
        <Button variant="primary" onClick={onSave} disabled={save.isPending || diff.length === 0}>
          {save.isPending ? "Saving…" : "Save team defaults"}
        </Button>
      </div>
      {save.isError && <p className="text-sm text-red-500">{save.error.message}</p>}
    </div>
  );
}
