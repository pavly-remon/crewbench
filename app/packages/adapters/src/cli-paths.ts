import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Cli } from "./types.js";

/** Each CLI's config/credentials directory. codex and copilot support an
 * env override (confirmed: `codex exec --help`'s "auth still uses
 * CODEX_HOME"; `copilot help environment`'s COPILOT_HOME entry); claude
 * and agy have no documented override as of writing. Ported from
 * crewbench_dispatch.py's CONFIG_DIRS (via crewbench_env.py). */
export function configDir(cli: Cli): string {
  switch (cli) {
    case "claude":
      return "~/.claude";
    case "codex":
      return process.env.CODEX_HOME || "~/.codex";
    case "agy":
      return "~/.gemini";
    case "copilot":
      return process.env.COPILOT_HOME || "~/.copilot";
  }
}

export function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return home + path.slice(1);
  }
  return path;
}

/** The executable to run for `cli`: CREWBENCH_CLI_OVERRIDE_<CLI> if set
 * (for tests -- inject a fake CLI script without touching the production
 * path), otherwise whatever's on PATH. Ported from
 * crewbench_dispatch.py's resolve_cli_path(). */
export function resolveCliPath(cli: Cli): string | null {
  const override = process.env[`CREWBENCH_CLI_OVERRIDE_${cli.toUpperCase()}`];
  if (override) return override;
  return findOnPath(cli);
}

function findOnPath(name: string): string | null {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const isWindows = process.platform === "win32";
  const extensions = isWindows ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** The argv prefix that actually launches `cliPath`. A single-element
 * passthrough for every real, installed CLI in production. Only matters
 * for CREWBENCH_CLI_OVERRIDE_<CLI> (tests): on Windows, a bare `.py` path
 * isn't directly executable via child_process.spawn (no shell, no file-
 * association lookup), so it's launched through the current Python
 * interpreter instead. Ported from crewbench_dispatch.py /
 * crewbench_env.py's cli_argv_prefix(). Uses `python3` (POSIX's usual
 * name) as the interpreter, since Node has no equivalent of Python's own
 * sys.executable to reuse here. */
export function cliArgvPrefix(cliPath: string): string[] {
  if (process.platform === "win32" && cliPath.toLowerCase().endsWith(".py")) {
    // Node has no equivalent of Python's own sys.executable to reuse here
    // (this only matters for CREWBENCH_CLI_OVERRIDE_<CLI> pointing at one
    // of tests/fixtures/fake_clis/*.py); fall back to whatever `python`
    // this platform's PATH resolves -- Windows commonly registers
    // `python`, not `python3`. On POSIX the fixture scripts are executable
    // with a shebang, so no interpreter prefix is needed there (matches
    // crewbench_dispatch.py's own POSIX behavior exactly).
    const interpreter = process.env.CREWBENCH_PYTHON || "python";
    return [interpreter, cliPath];
  }
  return [cliPath];
}
