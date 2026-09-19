import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoundsTimeline } from "../src/components/rounds-timeline.js";
import type { ApiRoundRecord } from "@crewbench/contract";

const rounds: ApiRoundRecord[] = [
  {
    round: 1,
    gate: { ok: true, steps: [] },
    tester: { verdict: "pass", failures: [] },
    reviewer: { verdict: "changes_requested", issues: [] },
    fixList: [],
  },
  {
    round: 2,
    gate: { ok: false, steps: [] },
    tester: null,
    reviewer: null,
    fixList: null,
  },
];

describe("RoundsTimeline", () => {
  it("renders one row per round with gate/tester/reviewer verdicts", () => {
    render(<RoundsTimeline rounds={rounds} />);
    expect(screen.getByText("round 1")).toBeInTheDocument();
    expect(screen.getByText("gate: ok")).toBeInTheDocument();
    expect(screen.getByText("tester: pass")).toBeInTheDocument();
    expect(screen.getByText("reviewer: changes_requested")).toBeInTheDocument();

    expect(screen.getByText("round 2")).toBeInTheDocument();
    expect(screen.getByText("gate: failed")).toBeInTheDocument();
  });

  it("shows an empty state with no rounds", () => {
    render(<RoundsTimeline rounds={[]} />);
    expect(screen.getByText(/no completed rounds yet/i)).toBeInTheDocument();
  });

  it("renders 'skipped' for a null gate (developer done, no gate run yet)", () => {
    render(
      <RoundsTimeline
        rounds={[{ round: 1, gate: null, tester: null, reviewer: null, fixList: null }]}
      />,
    );
    expect(screen.getByText("gate: skipped")).toBeInTheDocument();
  });
});
