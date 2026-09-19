import { join } from "node:path";
import { readJsonOrDefault } from "@crewbench/engine";
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
