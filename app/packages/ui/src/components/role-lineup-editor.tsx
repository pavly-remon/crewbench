import { useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { ApiCli, ApiDoctorReport, ApiEffort, RoleKey, Team } from "@crewbench/contract";
import { ROLE_KEYS } from "@crewbench/contract";
import { useAvailableModels } from "../api/models.js";
import { CURATED_MODELS } from "../lib/curated-models.js";
import type { LineupRoleValue } from "../lib/lineup-defaults.js";

const CLI_OPTIONS: ApiCli[] = ["claude", "codex", "agy", "copilot"];
const EFFORT_OPTIONS: ApiEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const CUSTOM_MODEL = "__custom__";
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

/** The model field: a dropdown for every CLI. When the daemon can
 * genuinely enumerate a CLI's models (`checked: true`, today only ever
 * `agy` -- see `@crewbench/adapters`' `listAvailableModels()`'s own
 * docstring, re-verified against the real installed binaries), the
 * dropdown's options are that live list. Otherwise they're the
 * hand-curated per-CLI list from `lib/curated-models.ts` (claude, codex,
 * copilot) -- real model names already referenced elsewhere in this
 * codebase, but NOT a live/verified list, which the caption below makes
 * explicit. Either way there's always a "type manually…" option that
 * swaps the dropdown for a free-text input, so an unlisted or
 * not-yet-released model name is never unreachable. */
function ModelField({ value, onChange }: { value: LineupRoleValue; onChange: (next: LineupRoleValue) => void }) {
  const { data, isLoading } = useAvailableModels(value.cli, true);
  const hasRealList = Boolean(data?.checked && data.available.length > 0);
  const baseOptions = hasRealList ? data!.available : CURATED_MODELS[value.cli] ?? [];
  // The role's current value may not be one of the listed ids (e.g. a
  // value carried over from team defaults that predates this list) --
  // kept as a real, selectable option rather than silently dropped, so
  // this dropdown never discards an already-valid choice out from under
  // the user.
  const options = baseOptions.includes(value.model) ? baseOptions : [value.model, ...baseOptions];
  const [manualOverride, setManualOverride] = useState(false);
  const manualMode = manualOverride || options.length === 0;

  if (manualMode) {
    return (
      <label className="col-span-2 flex flex-col gap-1 text-xs sm:col-span-1">
        Model
        <div className="flex gap-1">
          <input
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            placeholder={isLoading ? "loading model list…" : undefined}
            className="w-full min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
          {options.length > 0 && (
            <button
              type="button"
              title="back to the model dropdown"
              onClick={() => setManualOverride(false)}
              className="rounded-md border border-[var(--color-border)] px-2 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
            >
              list
            </button>
          )}
        </div>
      </label>
    );
  }

  return (
    <label className="col-span-2 flex flex-col gap-1 text-xs sm:col-span-1">
      Model
      <select
        value={value.model}
        onChange={(e) => {
          if (e.target.value === CUSTOM_MODEL) {
            setManualOverride(true);
            return;
          }
          onChange({ ...value, model: e.target.value });
        }}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={CUSTOM_MODEL}>Type manually…</option>
      </select>
      {!hasRealList && <p className="text-[10px] text-[var(--color-fg-muted)]">common models, not verified live</p>}
    </label>
  );
}

function RoleRow({
  role,
  value,
  doctorReports,
  onChange,
}: {
  role: RoleKey;
  value: LineupRoleValue;
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
        <ModelField key={value.cli} value={value} onChange={onChange} />
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
        <RoleRow key={role} role={role} value={roles[role]} doctorReports={doctorReports} onChange={(next) => onChange(role, next)} />
      ))}
    </div>
  );
}
