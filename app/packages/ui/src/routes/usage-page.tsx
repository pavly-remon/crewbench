import { useParams } from "@tanstack/react-router";
import { useProjectUsage } from "../api/doctor.js";

/** Unknown values render as "—", never "0" -- a real `0` would read as
 * "confirmed zero cost/duration," which is false when a CLI simply
 * doesn't report the number (this repo's `cost_usd: null` convention
 * from Phase 0, carried through the daemon's usage rollup). */
function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

export function UsagePage() {
  const { projectId } = useParams({ from: "/projects/$projectId/usage" });
  const { data: rows, isLoading, isError, error } = useProjectUsage(projectId);

  if (isLoading) return <p className="text-sm text-[var(--color-fg-muted)]">Loading usage…</p>;
  if (isError) return <p className="text-sm text-red-500">{error.message}</p>;
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No usage recorded for this project yet.</p>;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Usage</h1>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-muted)]">
            <th className="py-1.5 pr-3 font-medium">task</th>
            <th className="py-1.5 pr-3 font-medium">role</th>
            <th className="py-1.5 pr-3 font-medium">cli · model</th>
            <th className="py-1.5 pr-3 font-medium">runs</th>
            <th className="py-1.5 pr-3 font-medium">duration (s)</th>
            <th className="py-1.5 pr-3 font-medium">tokens</th>
            <th className="py-1.5 font-medium">cost (USD)</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row) =>
            Object.entries(row.usage).map(([role, usage]) => (
              <tr key={`${row.task_id}-${role}`} className="border-b border-[var(--color-border)] last:border-0">
                <td className="py-1.5 pr-3">{row.title}</td>
                <td className="py-1.5 pr-3">{role}</td>
                <td className="py-1.5 pr-3 text-xs text-[var(--color-fg-muted)]">
                  {usage.cli ?? "—"} · {usage.model ?? "—"}
                </td>
                <td className="py-1.5 pr-3">{usage.runs}</td>
                <td className="py-1.5 pr-3">{fmt(usage.duration_s)}</td>
                <td className="py-1.5 pr-3">{fmt(usage.total_tokens)}</td>
                <td className="py-1.5">{fmt(usage.cost_usd)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
