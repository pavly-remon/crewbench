import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { TaskSpec } from "@crewbench/contract";
import { Button } from "./button.js";

/** The spec editor gating scoping-chat -> lineup (Phase 3 milestone 3):
 * lets the user edit the lead's draft acceptance criteria before
 * confirming -- per the phase prompt's "spec editor (acceptance criteria
 * as an editable list)." Every other `TaskSpec` field (`description`,
 * `affected_areas`, `out_of_scope`, `constraints`) is shown read-only,
 * since the phase prompt names only acceptance criteria as editable
 * here. */
export function SpecEditor({
  spec,
  onConfirm,
  confirming,
}: {
  spec: TaskSpec;
  onConfirm: (spec: TaskSpec) => void;
  confirming: boolean;
}) {
  const [criteria, setCriteria] = useState<string[]>(spec.acceptance_criteria);
  const [newCriterion, setNewCriterion] = useState("");

  const addCriterion = () => {
    const trimmed = newCriterion.trim();
    if (!trimmed) return;
    setCriteria((prev) => [...prev, trimmed]);
    setNewCriterion("");
  };

  const removeCriterion = (index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold">{spec.title}</h3>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{spec.description}</p>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">Acceptance criteria</h4>
        <ul className="flex flex-col gap-1">
          {criteria.map((c, i) => (
            <li key={i} className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-sm">
              <span className="flex-1">{c}</span>
              <button type="button" onClick={() => removeCriterion(i)} aria-label={`Remove "${c}"`} className="text-[var(--color-fg-muted)] hover:text-red-500">
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <input
            value={newCriterion}
            onChange={(e) => setNewCriterion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCriterion();
              }
            }}
            placeholder="Add acceptance criterion…"
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
          <Button type="button" variant="secondary" onClick={addCriterion}>
            <Plus size={14} />
          </Button>
        </div>
      </div>

      {spec.affected_areas.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">Affected areas</h4>
          <p className="text-sm">{spec.affected_areas.join(", ")}</p>
        </div>
      )}
      {spec.out_of_scope.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">Out of scope</h4>
          <p className="text-sm">{spec.out_of_scope.join(", ")}</p>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={confirming || criteria.length === 0}
          onClick={() => onConfirm({ ...spec, acceptance_criteria: criteria })}
        >
          {confirming ? "Confirming…" : "Confirm spec"}
        </Button>
      </div>
    </div>
  );
}
