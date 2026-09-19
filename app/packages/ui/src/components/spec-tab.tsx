interface TaskSpecLike {
  title?: string;
  description?: string;
  acceptance_criteria?: string[];
  affected_areas?: string[];
  out_of_scope?: string[];
  constraints?: string[];
}

function List({ title, items }: { title: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">{title}</h3>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function SpecTab({ spec }: { spec: unknown }) {
  if (!spec) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No task spec recorded for this task.</p>;
  }
  const typed = spec as TaskSpecLike;
  return (
    <div className="flex flex-col gap-4">
      {typed.description && <p className="text-sm">{typed.description}</p>}
      <List title="Acceptance criteria" items={typed.acceptance_criteria} />
      <List title="Affected areas" items={typed.affected_areas} />
      <List title="Out of scope" items={typed.out_of_scope} />
      <List title="Constraints" items={typed.constraints} />
    </div>
  );
}
