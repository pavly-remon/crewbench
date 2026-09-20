import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { ApiCli, ApiDoctorReport, ApiEffort, RoleKey, Team } from "@crewbench/contract";
import { ROLE_KEYS } from "@crewbench/contract";
import { resolveModelTier, type LineupRoleValue } from "../lib/lineup-defaults.js";

const CLI_OPTIONS: ApiCli[] = ["claude", "codex", "agy", "copilot"];
const EFFORT_OPTIONS: ApiEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const ROLE_LABELS: Record<RoleKey, string> = {
  developer: "Developer",
  tester: "Tester",
  "code-reviewer": "Code reviewer",
  "ui-ux": "UI/UX (opt-in)",
};

function DoctorBadge({ report }: { report: ApiDoctorReport | undefined }) {
  if (!report) return null;
  return report.ok ? (
    <span title="doctor: ok" className="text-green-500">
      <CheckCircle2 size={14} />
    </span>
  ) : (
    <span title={report.errors.join("; ") || "doctor: not ok"} className="text-red-500">
      <XCircle size={14} />
    </span>
  );
}

function RoleRow({
  role,
  value,
  team,
  doctorReports,
  onChange,
}: {
  role: RoleKey;
  value: LineupRoleValue;
  team: Team | undefined;
  doctorReports: ApiDoctorReport[] | undefined;
  onChange: (next: LineupRoleValue) => void;
}) {
  const report = doctorReports?.find((r) => r.cli === value.cli);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{ROLE_LABELS[role]}</span>
        <DoctorBadge report={report} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs">
          CLI
          <select
            value={value.cli}
            onChange={(e) => onChange({ ...value, cli: e.target.value as ApiCli })}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            {CLI_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 flex flex-col gap-1 text-xs sm:col-span-1">
          Model
          <div className="flex gap-1">
            <input
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
              className="w-full min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex gap-1">
            {(["cheap", "strong"] as const).map((tier) => (
              <button
                key={tier}
                type="button"
                title={`use the ${tier} tier for ${value.cli}`}
                onClick={() => onChange({ ...value, model: resolveModelTier(tier, value.cli, team) })}
                className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
              >
                {tier}
              </button>
            ))}
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Effort
          <select
            value={value.effort}
            onChange={(e) => onChange({ ...value, effort: e.target.value as ApiEffort })}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            {EFFORT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Permissions
          <select
            value={value.permissions}
            onChange={(e) => onChange({ ...value, permissions: e.target.value as "safe" | "skip" })}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            <option value="safe">safe</option>
            <option value="skip">skip</option>
          </select>
        </label>
      </div>
      {value.permissions === "skip" && (
        <p className="flex items-center gap-1.5 text-xs text-amber-500">
          <AlertTriangle size={13} />
          "skip" bypasses this role's own permission prompts -- it can run commands and edit files without asking.
        </p>
      )}
    </div>
  );
}

/** Shared per-role CLI/model/effort/permissions editor (Phase 3
 * milestone 4) -- the lineup step's own core UI and, unlike the lineup
 * step, the actual "team roster" the team settings page edits are the
 * same four-role shape, so this is reused rather than duplicated. */
export function RoleLineupEditor({
  roles,
  team,
  doctorReports,
  onChange,
}: {
  roles: Record<RoleKey, LineupRoleValue>;
  team: Team | undefined;
  doctorReports: ApiDoctorReport[] | undefined;
  onChange: (role: RoleKey, next: LineupRoleValue) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {ROLE_KEYS.map((role) => (
        <RoleRow key={role} role={role} value={roles[role]} team={team} doctorReports={doctorReports} onChange={(next) => onChange(role, next)} />
      ))}
    </div>
  );
}
