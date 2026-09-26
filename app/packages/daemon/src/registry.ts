import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteJson, lockedReadModifyWrite, nowIso, readJsonOrDefault } from "@crewbench/engine";
import { ProjectsRegistrySchema, type ProjectsRegistry, type RegisteredProject } from "@crewbench/contract";

const execFileAsync = promisify(execFile);

/** `~/.crewbench/` -- the daemon's own home, distinct from any project's
 * own `<project>/.crewbench/` task directory (docs/app/phase-2-plan.md's
 * milestone 1). `CREWBENCH_HOME` overrides it for tests, same pattern as
 * `CREWBENCH_ROOT` overriding the plugin-root lookup elsewhere in this
 * app. */
export function daemonHome(): string {
  return process.env.CREWBENCH_HOME ?? join(homedir(), ".crewbench");
}

function registryPath(): string {
  return join(daemonHome(), "projects.json");
}

function registryLockPath(): string {
  return join(daemonHome(), ".projects.lock");
}

export async function loadRegistry(): Promise<ProjectsRegistry> {
  const raw = await readJsonOrDefault<unknown>(registryPath(), {});
  const parsed = ProjectsRegistrySchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** Phase 4 milestone 4 (Design decision 4, finding 5): the real bug
 * class Phase 0 already fixed for `state.json`/`index.json` on the
 * Python side (`crewbench_fs.py`'s `locked_read_modify_write`), ported
 * in spirit here (not verbatim -- different language, same shape) via
 * `@crewbench/engine`'s own `lockedReadModifyWrite()`, already built and
 * used by `task-store.ts`/`runner.ts` for the identical reason. Before
 * this, `addProject()`/`removeProject()` each did a plain
 * load-then-`atomicWriteJson()` with no lock spanning the two -- two
 * concurrent writers (two `crewbench ui` processes, or one process
 * handling two racing `POST /api/projects` calls) could each read the
 * same registry, mutate their own copy, and the second writer's
 * `atomicWriteJson()` would silently clobber the first writer's entry
 * entirely. Rare when a person has to manually run `crewbench ui` twice
 * to hit it; becomes the normal case once Design decision 4's background
 * service can keep one daemon running silently at login while the same
 * person also opens a second one by hand. */
async function mutateRegistry<T>(fn: (registry: ProjectsRegistry) => T): Promise<T> {
  return lockedReadModifyWrite(registryLockPath(), async () => {
    const registry = await loadRegistry();
    const result = fn(registry);
    await atomicWriteJson(registryPath(), registry);
    return result;
  });
}

export class NotAGitRepoError extends Error {
  constructor(path: string) {
    super(`${path} is not a git repository`);
    this.name = "NotAGitRepoError";
  }
}

async function assertGitRepo(path: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path });
    if (stdout.trim() !== "true") throw new NotAGitRepoError(path);
  } catch (err) {
    if (err instanceof NotAGitRepoError) throw err;
    throw new NotAGitRepoError(path);
  }
}

/** Adds a project to the registry, validating it's a real git repo first
 * (the phase prompt: "Adding validates that it is a git repo"). Resolves
 * the path to absolute (the registry's contract per Design decision --
 * `docs/app/phase-2-plan.md` -- is a list of *absolute* project paths) so
 * a later `crewbench ui` invocation from a different cwd doesn't change
 * what a previously-added relative path means. Idempotent on the same
 * absolute path: re-adding updates `name` rather than creating a
 * duplicate entry, since the id is derived from the path itself. */
export async function addProject(path: string, name?: string): Promise<RegisteredProject> {
  const absolute = resolve(path);
  await assertGitRepo(absolute);
  // The existing-entry lookup and the id it decides on must happen
  // *inside* the same locked critical section as the write -- deciding
  // "no existing entry, mint a fresh id" outside the lock (the pre-fix
  // shape) is exactly the read-modify-write race mutateRegistry() exists
  // to close: two concurrent adds of the same brand-new path could each
  // see no existing entry and each mint a different random id, leaving
  // two duplicate registry entries for one path instead of the one
  // idempotent entry this function's own docstring promises.
  return mutateRegistry((registry) => {
    const existing = Object.values(registry).find((p) => p.path === absolute);
    const entry: RegisteredProject = {
      id: existing?.id ?? randomBytes(8).toString("hex"),
      path: absolute,
      name: name ?? existing?.name ?? absolute.split(/[/\\]/).filter(Boolean).pop() ?? absolute,
      added_at: existing?.added_at ?? nowIso(),
    };
    registry[entry.id] = entry;
    return entry;
  });
}

export async function removeProject(id: string): Promise<boolean> {
  return mutateRegistry((registry) => {
    if (!(id in registry)) return false;
    delete registry[id];
    return true;
  });
}

export async function getProject(id: string): Promise<RegisteredProject | null> {
  const registry = await loadRegistry();
  return registry[id] ?? null;
}
