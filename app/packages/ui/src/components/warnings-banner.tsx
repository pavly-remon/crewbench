import { TriangleAlert } from "lucide-react";

export function WarningsBanner({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <div className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
        <TriangleAlert size={16} />
        Git safety warnings
      </div>
      <ul className="list-disc pl-5">
        {warnings.map((warning, i) => (
          <li key={i}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}
