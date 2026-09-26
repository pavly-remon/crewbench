import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Finds the crewbench plugin root (the directory containing `agents/` and
 * `schemas/`) -- the daemon needs the same lookup `packages/cli`'s
 * `root.ts` already does, for the same reason (role briefs, result
 * schemas), to build a `DriveTaskParams` when reattaching or starting a
 * task (Phase 3 milestone 1). Deliberately duplicated here rather than
 * imported from `packages/cli`: `packages/cli` already depends on
 * `packages/daemon` (for `crewbench ui`), so importing the reverse
 * direction would create a cycle. `CREWBENCH_ROOT` overrides everything,
 * same override this app already uses everywhere else it needs to find
 * its own install root. */
export function findRoot(): string {
  const override = process.env.CREWBENCH_ROOT;
  if (override && isValidRoot(override)) return override;

  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i++) {
    if (isValidRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "could not find the crewbench root (a directory containing both agents/ and schemas/) -- " +
      "set CREWBENCH_ROOT to it explicitly.",
  );
}

function isValidRoot(dir: string): boolean {
  return existsSync(join(dir, "agents")) && existsSync(join(dir, "schemas"));
}

export function schemaPath(root: string, role: string): string {
  return resolve(root, "schemas", `${role}.json`);
}

export function agentsDir(root: string): string {
  return resolve(root, "agents");
}
