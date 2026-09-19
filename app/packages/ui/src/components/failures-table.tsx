import type { ApiRoundRecord, ApiTestFailure } from "@crewbench/contract";

interface RowWithRound extends ApiTestFailure {
  round: number;
}

export function FailuresTable({ rounds }: { rounds: ApiRoundRecord[] }) {
  const rows: RowWithRound[] = rounds.flatMap((round) => (round.tester?.failures ?? []).map((f) => ({ ...f, round: round.round })));
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No test failures recorded.</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-muted)]">
          <th className="py-1.5 pr-3 font-medium">round</th>
          <th className="py-1.5 pr-3 font-medium">test</th>
          <th className="py-1.5 pr-3 font-medium">file</th>
          <th className="py-1.5 font-medium">reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${row.round}-${row.test}-${i}`} className="border-b border-[var(--color-border)] last:border-0">
            <td className="py-1.5 pr-3">{row.round}</td>
            <td className="py-1.5 pr-3 font-mono text-xs">{row.test}</td>
            <td className="py-1.5 pr-3 font-mono text-xs">{row.file}</td>
            <td className="py-1.5 text-[var(--color-fg-muted)]">{row.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
