/** A small, dependency-free unified-diff renderer -- Design decision 6
 * (docs/app/phase-2-plan.md) left the diff-viewer library choice open
 * until this milestone actually needed one. Resolved here: the daemon
 * already returns a plain unified-diff string (`git diff`'s own output,
 * `packages/daemon/src/diff.ts`), and a monospace `<pre>` with per-line
 * color coding renders it correctly with zero added dependencies --
 * pulling in `react-diff-view`/`diff2html` would buy side-by-side/
 * inline toggle UI this milestone doesn't ask for, at the cost of a new
 * dependency for something a ~30-line component already covers. */
function lineClassName(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-[var(--color-fg-muted)]";
  if (line.startsWith("@@")) return "text-[var(--color-accent)]";
  if (line.startsWith("+")) return "bg-green-500/10 text-green-600 dark:text-green-400";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-600 dark:text-red-400";
  return "text-[var(--color-fg)]";
}

export function DiffViewer({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No diff to show.</p>;
  }
  const lines = diff.split("\n");
  return (
    <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] p-3 text-xs leading-5">
      {lines.map((line, i) => (
        <div key={i} className={lineClassName(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
