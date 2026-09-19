import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Cli, DoctorReport } from "./types.js";
import { cliArgvPrefix, configDir, expandHome, resolveCliPath } from "./cli-paths.js";

const execFileAsync = promisify(execFile);

/** VERIFY: each CLI's most likely API host based on its documented auth/
 * provider, not confirmed from CLI docs -- a false negative here (host
 * reachable but this isn't the real endpoint) is possible; the auth-status
 * check is the stronger signal. Ported from
 * crewbench_dispatch.py's NETWORK_CHECK_HOSTS. */
const NETWORK_CHECK_HOSTS: Record<Cli, [string, number]> = {
  claude: ["api.anthropic.com", 443],
  codex: ["api.openai.com", 443],
  agy: ["generativelanguage.googleapis.com", 443],
  copilot: ["api.github.com", 443],
};

function networkCheckTarget(cli: Cli): [string, number] {
  const override = process.env[`CREWBENCH_NETWORK_CHECK_OVERRIDE_${cli.toUpperCase()}`];
  if (override?.includes(":")) {
    const idx = override.lastIndexOf(":");
    const host = override.slice(0, idx);
    const port = Number.parseInt(override.slice(idx + 1), 10);
    if (host && !Number.isNaN(port)) return [host, port];
  }
  return NETWORK_CHECK_HOSTS[cli];
}

function networkOk(cli: Cli, timeoutMs = 3000): Promise<[boolean, string]> {
  const [host, port] = networkCheckTarget(cli);
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    const finish = (ok: boolean, detail: string) => {
      socket.destroy();
      resolve([ok, detail]);
    };
    socket.once("connect", () => finish(true, `reached ${host}:${port}`));
    socket.once("timeout", () => finish(false, `could not reach ${host}:${port} (timed out)`));
    socket.once("error", (err) => finish(false, `could not reach ${host}:${port} (${err.message})`));
  });
}

/** (loggedIn, detail) using the cheapest non-interactive status command
 * each CLI offers. Confirmed live: `claude auth status --json`
 * (loggedIn bool + email) and `codex login status` (exit 0 + "Logged in
 * as ..." / exit non-zero otherwise). agy falls back to `agy models`, a
 * real (cheap) network+auth call; copilot falls back to checking for a
 * stored credential/token file, weaker evidence than an actual call.
 * Ported field-for-field from crewbench_dispatch.py's _auth_check(). */
async function authCheck(cli: Cli, cliPath: string): Promise<[boolean, string]> {
  try {
    if (cli === "claude") {
      const { stdout } = await execFileAsync(...splitArgv(cliArgvPrefix(cliPath), ["auth", "status", "--json"]), {
        timeout: 15_000,
      });
      const data: unknown = JSON.parse(stdout || "{}");
      const loggedIn = typeof data === "object" && data !== null && Boolean((data as Record<string, unknown>).loggedIn);
      const email = typeof data === "object" && data !== null ? (data as Record<string, unknown>).email : undefined;
      return [loggedIn, String(email ?? stdout.trim())];
    }
    if (cli === "codex") {
      try {
        const { stdout } = await execFileAsync(...splitArgv(cliArgvPrefix(cliPath), ["login", "status"]), {
          timeout: 15_000,
        });
        return [true, stdout.trim()];
      } catch (err) {
        return [false, execErrorOutput(err)];
      }
    }
    if (cli === "agy") {
      try {
        const { stdout } = await execFileAsync(...splitArgv(cliArgvPrefix(cliPath), ["models"]), { timeout: 20_000 });
        const lines = stdout.trim().split("\n").filter(Boolean);
        return [lines.length > 0, lines[0] ?? "no output"];
      } catch (err) {
        return [false, execErrorOutput(err) || "no output"];
      }
    }
    // copilot: no dedicated status command documented as of writing.
    const hasToken = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].some((v) => process.env[v]);
    const hasStored = existsSync(join(expandHome(configDir("copilot")), "config.json"));
    const ok = hasToken || hasStored;
    const detail = ok
      ? "found a token env var or stored credential (best-effort check only — VERIFY, no dedicated status command found)"
      : "no token env var or stored credential found — VERIFY, this check can't positively confirm login without a real prompt call";
    return [ok, detail];
  } catch (err) {
    return [false, err instanceof Error ? err.message : String(err)];
  }
}

function splitArgv(prefix: string[], rest: string[]): [string, string[]] {
  const [command, ...prefixRest] = prefix;
  return [command as string, [...prefixRest, ...rest]];
}

function execErrorOutput(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout || e.stderr || "").trim();
  }
  return String(err);
}

/** True if `path` is already a writable directory, or doesn't exist yet
 * but could be (its nearest existing ancestor is a writable directory).
 * Ported field-for-field from crewbench_dispatch.py's _dir_writable(). */
export function dirWritable(path: string): boolean {
  if (existsSync(path)) {
    try {
      accessSync(path, fsConstants.W_OK);
      return isDirectory(path);
    } catch {
      return false;
    }
  }
  let ancestor = dirname(path);
  let previous: string | null = null;
  while (ancestor !== previous) {
    if (existsSync(ancestor)) {
      try {
        accessSync(ancestor, fsConstants.W_OK);
        return isDirectory(ancestor);
      } catch {
        return false;
      }
    }
    previous = ancestor;
    ancestor = dirname(ancestor);
  }
  return false;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `doctor --cli <cli>` — preflight for delegating to <cli> from inside a
 * (possibly sandboxed) host: is it installed, is its config dir writable,
 * can it reach its API, is it logged in. Ported field-for-field from
 * crewbench_dispatch.py's cmd_doctor(). */
export async function doctor(cli: Cli): Promise<DoctorReport> {
  const report: DoctorReport = {
    cli,
    installed: false,
    version: null,
    config_dir: null,
    config_dir_writable: null,
    network_ok: null,
    network_detail: null,
    logged_in: null,
    auth_detail: null,
    ok: false,
    errors: [],
  };

  const cliPath = resolveCliPath(cli);
  if (!cliPath) {
    report.errors.push(`${cli} is not installed or not on PATH`);
    return report;
  }
  report.installed = true;

  try {
    const { stdout, stderr } = await execFileAsync(...splitArgv(cliArgvPrefix(cliPath), ["--version"]), {
      timeout: 10_000,
    });
    report.version = (stdout || stderr).trim();
  } catch (err) {
    report.errors.push(`could not read ${cli}'s version: ${err instanceof Error ? err.message : String(err)}`);
  }

  const dir = expandHome(configDir(cli));
  report.config_dir = dir;
  const writable = dirWritable(dir);
  report.config_dir_writable = writable;
  if (!writable) {
    report.errors.push(
      `${cli}'s config dir (${dir}) isn't writable from here (and can't be created) — a headless ` +
        "child needs to read (and sometimes refresh) its login there",
    );
  }

  const [netOk, netDetail] = await networkOk(cli);
  report.network_ok = netOk;
  report.network_detail = netDetail;
  if (!netOk) {
    report.errors.push(`host sandbox blocks network — the ${cli} child can't reach its API (${netDetail})`);
  }

  const [loggedIn, authDetail] = await authCheck(cli, cliPath);
  report.logged_in = loggedIn;
  report.auth_detail = authDetail;
  if (!loggedIn) {
    report.errors.push(`${cli} does not appear to be logged in (${authDetail}) — run its login command outside the sandbox, then retry`);
  }

  report.ok = report.errors.length === 0;
  return report;
}
