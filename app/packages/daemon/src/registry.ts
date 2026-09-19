import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteJson, nowIso, readJsonOrDefault } from "@crewbench/engine";
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

export async function loadRegistry(): Promise<ProjectsRegistry> {
  const raw = await readJsonOrDefault<unknown>(registryPath(), {});
  const parsed = ProjectsRegistrySchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

async function saveRegistry(registry: ProjectsRegistry): Promise<void> {
  await atomicWriteJson(registryPath(), registry);
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
  const registry = await loadRegistry();
  const existing = Object.values(registry).find((p) => p.path === absolute);
  const entry: RegisteredProject = {
    id: existing?.id ?? randomBytes(8).toString("hex"),
    path: absolute,
    name: name ?? existing?.name ?? absolute.split(/[/\\]/).filter(Boolean).pop() ?? absolute,
    added_at: existing?.added_at ?? nowIso(),
  };
  registry[entry.id] = entry;
  await saveRegistry(registry);
  return entry;
}

export async function removeProject(id: string): Promise<boolean> {
  const registry = await loadRegistry();
  if (!(id in registry)) return false;
  delete registry[id];
  await saveRegistry(registry);
  return true;
}

export async function getProject(id: string): Promise<RegisteredProject | null> {
  const registry = await loadRegistry();
  return registry[id] ?? null;
}
