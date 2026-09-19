import type { ApiRegisteredIssue } from "@crewbench/contract";

const SEVERITY_COLOR: Record<ApiRegisteredIssue["severity"], string> = {
  blocker: "text-red-500",
  major: "text-amber-500",
  minor: "text-[var(--color-fg-muted)]",
};

const STATUS_LABEL: Record<ApiRegisteredIssue["status"], string> = {
  open: "open",
  resolved: "resolved",
  still_present: "still present",
};

export function IssuesTable({ issues }: { issues: ApiRegisteredIssue[] }) {
  if (issues.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No issues recorded.</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-muted)]">
          <th className="py-1.5 pr-3 font-medium">id</th>
          <th className="py-1.5 pr-3 font-medium">severity</th>
          <th className="py-1.5 pr-3 font-medium">file</th>
          <th className="py-1.5 pr-3 font-medium">category</th>
          <th className="py-1.5 pr-3 font-medium">status</th>
          <th className="py-1.5 font-medium">first seen</th>
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <tr key={issue.id} className="border-b border-[var(--color-border)] last:border-0">
            <td className="py-1.5 pr-3 font-mono text-xs">{issue.id}</td>
            <td className={`py-1.5 pr-3 ${SEVERITY_COLOR[issue.severity]}`}>{issue.severity}</td>
            <td className="py-1.5 pr-3 font-mono text-xs">{issue.file}</td>
            <td className="py-1.5 pr-3">{issue.category}</td>
            <td className="py-1.5 pr-3">{STATUS_LABEL[issue.status]}</td>
            <td className="py-1.5">round {issue.firstSeenRound}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
