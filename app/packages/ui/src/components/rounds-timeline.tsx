import type { ApiRoundRecord } from "@crewbench/contract";
import { Card } from "./card.js";

export function RoundsTimeline({ rounds }: { rounds: ApiRoundRecord[] }) {
  if (rounds.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No completed rounds yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {rounds.map((round) => (
        <Card key={round.round} className="flex flex-wrap items-center gap-4 text-sm">
          <span className="font-medium">round {round.round}</span>
          <span className={round.gate?.ok === false ? "text-red-500" : "text-[var(--color-fg-muted)]"}>
            gate: {round.gate === null ? "skipped" : round.gate.ok ? "ok" : "failed"}
          </span>
          {round.tester && (
            <span className={round.tester.verdict === "pass" ? "text-[var(--color-fg-muted)]" : "text-red-500"}>
              tester: {round.tester.verdict}
            </span>
          )}
          {round.reviewer && (
            <span className={round.reviewer.verdict === "approve" ? "text-[var(--color-fg-muted)]" : "text-amber-500"}>
              reviewer: {round.reviewer.verdict}
            </span>
          )}
        </Card>
      ))}
    </div>
  );
}
