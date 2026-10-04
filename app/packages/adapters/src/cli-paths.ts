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
 * for CREWBENCH_CLI_OVERRIDE_<CLI> (tests): on Windows, a bare `.py` or
 * `.js`/`.cjs`/`.mjs` path isn't directly executable via
 * child_process.spawn (no shell, no file-association lookup, and no
 * shebang support at all) -- EFTYPE otherwise, a real failure caught live
 * in CI (packages/engine's own test/runner.test.ts and test/scoping.test.ts
 * write throwaway `.cjs` fake-CLI fixtures and `chmod` them, which only
 * makes them executable on POSIX). Launched through the current Python
 * or Node interpreter instead. Ported from crewbench_dispatch.py /
 * crewbench_env.py's cli_argv_prefix() for the `.py` case; the JS case
 * has no Python-side equivalent to port, since those fixtures are
 * TypeScript-test-only. On POSIX the fixture scripts are executable with
 * a shebang, so no interpreter prefix is needed there either way (matches
 * crewbench_dispatch.py's own POSIX behavior exactly). */
export function cliArgvPrefix(cliPath: string): string[] {
  if (process.platform !== "win32") return [cliPath];
  const lower = cliPath.toLowerCase();
  if (lower.endsWith(".py")) {
    // Windows commonly registers `python`, not `python3`; no equivalent
    // of Python's own sys.executable to reuse here since this is Node.
    const interpreter = process.env.CREWBENCH_PYTHON || "python";
    return [interpreter, cliPath];
  }
  if (lower.endsWith(".js") || lower.endsWith(".cjs") || lower.endsWith(".mjs")) {
    // process.execPath is the actual Node binary running this process --
    // always correct, unlike guessing a `node` name off PATH.
    return [process.execPath, cliPath];
  }
  return [cliPath];
}
