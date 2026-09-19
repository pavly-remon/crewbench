import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IssuesTable } from "../src/components/issues-table.js";
import type { ApiRegisteredIssue } from "@crewbench/contract";

const issues: ApiRegisteredIssue[] = [
  {
    id: "R1-1",
    firstSeenRound: 1,
    file: "src/foo.ts",
    category: "correctness",
    severity: "blocker",
    change: "off-by-one in the loop bound",
    status: "still_present",
    consecutiveStillPresent: 2,
  },
  {
    id: "R1-2",
    firstSeenRound: 1,
    file: "src/bar.ts",
    category: "style",
    severity: "minor",
    change: "inconsistent naming",
    status: "resolved",
    consecutiveStillPresent: 0,
  },
];

describe("IssuesTable", () => {
  it("renders one row per issue with id, severity, file, category, and status", () => {
    render(<IssuesTable issues={issues} />);
    expect(screen.getByText("R1-1")).toBeInTheDocument();
    expect(screen.getByText("blocker")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
    expect(screen.getByText("correctness")).toBeInTheDocument();
    expect(screen.getByText("still present")).toBeInTheDocument();

    expect(screen.getByText("R1-2")).toBeInTheDocument();
    expect(screen.getByText("resolved")).toBeInTheDocument();
  });

  it("shows an empty state with no issues", () => {
    render(<IssuesTable issues={[]} />);
    expect(screen.getByText(/no issues recorded/i)).toBeInTheDocument();
  });
});
