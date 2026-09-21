import { useEffect, useState } from "react";
import type { DaemonConfig, RoleKey, Team } from "@crewbench/contract";
import { ApiCliSchema } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { RoleLineupEditor } from "../components/role-lineup-editor.js";
import { useConfig, useSaveConfig } from "../api/config.js";
import { useDoctor } from "../api/doctor.js";
import { suggestLineup, type LineupRoleValue } from "../lib/lineup-defaults.js";

const CLI_OPTIONS = ApiCliSchema.options;

/** The global settings page (Phase 4 milestone 4, Design decision 5) --
 * `~/.crewbench/config.json`'s own fields, machine-wide rather than
 * per-project. Reuses `RoleLineupEditor` for `default_lineup` exactly
 * like `team-settings-page.tsx` does for a project's own `team.json`
 * (same shape, `RoleLineupSchema`, just one level higher) -- passing a
 * bare `{roles: config.default_lineup}` to `suggestLineup()` in place of
 * a real `Team` object works because every other `Team` field it reads
 * is optional.
 *
 * **`notifications`/`theme` here are deliberately NOT wired to the
 * existing client-side-only mechanisms** (`lib/notifications.ts`'s
 * `localStorage` opt-in, `lib/theme.ts`'s `useTheme()`) -- both of those
 * files' own docstrings say "never anything the daemon needs to know
 * about," and this milestone doesn't relitigate that. These two fields
 * are only the machine-wide *default* a fresh browser profile/tab could
 * in principle seed its own local state from -- an intentionally
 * unwired, disclosed gap, not a bug: actually wiring a fresh tab's first
 * render to read `GET /api/config` before falling back to
 * `prefers-color-scheme`/no-opt-in is a real, separate change to
 * already-shipped Phase 3 code this milestone didn't make. */
export function SettingsPage() {
  const { data: config, isLoading } = useConfig();
  const { data: doctor } = useDoctor();
  const save = useSaveConfig();

  const [port, setPort] = useState("");
  const [concurrency, setConcurrency] = useState<Partial<Record<string, string>>>({});
  const [notifications, setNotifications] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  const [lineup, setLineup] = useState<Record<RoleKey, LineupRoleValue> | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (config === undefined || seeded) return;
    setPort(config.port ? String(config.port) : "");
    const c: Partial<Record<string, string>> = {};
    for (const cli of CLI_OPTIONS) if (config.concurrency?.[cli] !== undefined) c[cli] = String(config.concurrency[cli]);
    setConcurrency(c);
    setNotifications(config.notifications ?? false);
    setTheme(config.theme ?? "system");
    setLineup(suggestLineup({ roles: config.default_lineup } as Team));
    setSeeded(true);
  }, [config, seeded]);

  if (isLoading || !lineup) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }

  const onSave = () => {
    const nextConfig: DaemonConfig = { ...config };
    nextConfig.port = port.trim() ? Number(port) : undefined;
    const nextConcurrency: Record<string, number> = {};
    for (const [cli, value] of Object.entries(concurrency)) {
      if (value && value.trim()) nextConcurrency[cli] = Number(value);
    }
    nextConfig.concurrency = Object.keys(nextConcurrency).length > 0 ? nextConcurrency : undefined;
    nextConfig.notifications = notifications;
    nextConfig.theme = theme;
    const nextLineup: Team["roles"] = {};
    for (const role of Object.keys(lineup) as RoleKey[]) {
      const r = lineup[role];
      nextLineup[role] = { cli: r.cli, model: r.model, effort: r.effort, permissions: r.permissions };
    }
    nextConfig.default_lineup = nextLineup;
    save.mutate(nextConfig);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Daemon</h2>
        <label className="flex flex-col gap-1 text-sm">
          Port
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="4287 (default)"
            className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
        </label>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Takes effect the next time <code>crewbench ui</code> starts, not the currently running one.
        </p>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Per-CLI concurrency limit</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CLI_OPTIONS.map((cli) => (
            <label key={cli} className="flex flex-col gap-1 text-xs capitalize">
              {cli}
              <input
                value={concurrency[cli] ?? ""}
                onChange={(e) => setConcurrency((prev) => ({ ...prev, [cli]: e.target.value }))}
                placeholder="2 (default)"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
              />
            </label>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Default lineup</h2>
        <p className="text-xs text-[var(--color-fg-muted)]">Used when a project has no <code>team.json</code> of its own yet.</p>
        <RoleLineupEditor
          roles={lineup}
          team={{ roles: config?.default_lineup } as Team}
          doctorReports={doctor?.reports}
          onChange={(role, next) => setLineup((prev) => (prev ? { ...prev, [role]: next } : prev))}
        />
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Notifications &amp; theme</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notifications} onChange={(e) => setNotifications(e.target.checked)} />
          Desktop notifications on by default
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Theme
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as "light" | "dark" | "system")}
            className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
      {save.isError && <p className="text-sm text-red-500">{save.error.message}</p>}
      {save.isSuccess && <p className="text-sm text-green-500">Saved.</p>}
    </div>
  );
}
