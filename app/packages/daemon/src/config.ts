import { join } from "node:path";
import { atomicWriteJson, readJsonOrDefault } from "@crewbench/engine";
import { DaemonConfigSchema, type DaemonConfig } from "@crewbench/contract";
import { daemonHome } from "./registry.js";

export const DEFAULT_PORT = 4287;

function configPath(): string {
  return join(daemonHome(), "config.json");
}

export async function loadConfig(): Promise<DaemonConfig> {
  const raw = await readJsonOrDefault<unknown>(configPath(), {});
  const parsed = DaemonConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** `PUT /api/config` (Phase 4 milestone 4, Design decision 5). Not
 * locked the way `registry.ts`'s `mutateRegistry()` now is: unlike
 * `projects.json` (many concurrent `POST /api/projects` callers racing
 * each other in normal use), `config.json` has exactly one real writer
 * -- a person editing the settings page -- so the same read-modify-write
 * race finding 5 called out for the registry doesn't apply here with
 * comparable severity; a plain `atomicWriteJson()` (still crash-safe on
 * its own) matches `team.json`/`profile.json`'s existing PUT routes'
 * own locking posture. **A real, disclosed limitation**: `port` and
 * `concurrency` are read once at `startDaemon()`'s own startup and baked
 * into that process (the `ConcurrencyLimiter` instance, the bound port)
 * -- saving a new value here takes effect on the *next* `crewbench ui`
 * start, not the currently-running one, same as changing `port` already
 * required a restart before this milestone existed at all. */
export async function saveConfig(config: DaemonConfig): Promise<void> {
  await atomicWriteJson(configPath(), config);
}
