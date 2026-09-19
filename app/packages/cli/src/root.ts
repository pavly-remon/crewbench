import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Finds the crewbench plugin root (the directory containing `agents/` and
 * `schemas/`) -- this CLI reads role briefs and result schemas from there,
 * same as the plugin does (lib/dispatch.md's own root-resolution note).
 * `CREWBENCH_ROOT` overrides everything, for tests and for a future
 * packaged install where the root isn't a fixed number of directories up
 * from this file (see docs/app/phase-1-plan.md's milestone 5 being
 * explicitly scoped to the monorepo dev layout -- Phase 4 handles
 * packaging a published npm install, which needs its own root-finding
 * strategy since `agents/`/`schemas/` would ship bundled with the
 * package, not two levels above a source repo). */
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

export function defaultsPath(root: string): string {
  return resolve(root, "config", "defaults.json");
}
