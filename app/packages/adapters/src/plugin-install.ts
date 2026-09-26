import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Cli } from "./types.js";
import { cliArgvPrefix } from "./cli-paths.js";

const execFileAsync = promisify(execFile);

/** Real per-CLI plugin-install commands (Phase 4 milestone 2's own
 * onboarding "offer to install the plugin" step) -- confirmed live
 * against each CLI's real `--help` output and this repo's own
 * `.claude-plugin/marketplace.json` (`"name": "PiCode-marketplace"`),
 * not copied from README.md's own (slightly stale) instructions:
 *
 * - **claude**: `claude plugin marketplace add <repo>` then `claude
 *   plugin install crewbench@PiCode-marketplace -y` -- both real,
 *   non-interactive subcommands (`claude plugin --help`); README only
 *   documents the interactive `/plugin ...` slash-command form, which
 *   this app can't run headlessly at all, so the real CLI subcommand
 *   form is used here instead, not what the docs show.
 * - **copilot**: `copilot plugin marketplace add <repo>` then `copilot
 *   plugin install crewbench@PiCode-marketplace` -- matches README
 *   exactly, confirmed against `copilot plugin --help`.
 * - **codex**: `codex plugin marketplace add <repo>` then `codex plugin
 *   add crewbench@PiCode-marketplace` -- also a real, non-interactive
 *   pair (`codex plugin --help`), better than README's own instructions
 *   (which describe installing crewbench via the *interactive* `/plugins`
 *   menu after adding the marketplace, since older codex builds
 *   apparently didn't have `plugin add` yet). **VERIFY**: no
 *   `.codex-plugin/marketplace.json` exists in this repo to confirm
 *   codex derives the exact same `PiCode-marketplace` name from
 *   `.claude-plugin/marketplace.json` when adding this repo as a
 *   marketplace -- if the name genuinely differs, the second step's
 *   real error message is surfaced to the caller as-is, not masked.
 * - **agy**: `agy plugin install <repo-url>` -- a single step, no
 *   marketplace concept for agy at all (confirmed: `agy plugin --help`
 *   lists no `marketplace` subcommand). `agy plugin install` accepts a
 *   remote GitHub URL directly (confirmed live against the real
 *   `pavly-remon/crewbench` repo during this milestone's own
 *   investigation -- disclosed in the milestone log, since that
 *   investigation step itself touched a real, already-installed local
 *   agy plugin registration it should not have; every *test* of this
 *   module instead points `CREWBENCH_CLI_OVERRIDE_AGY` at a fake script,
 *   never a real `agy` binary). No local clone needed first, unlike
 *   README's own two-step "clone, then `agy plugin install ./crewbench`"
 *   instructions. */
const MARKETPLACE_REPO = "pavly-remon/crewbench";
const MARKETPLACE_NAME = "PiCode-marketplace";
const PLUGIN_NAME = "crewbench";

export interface InstallPluginStep {
  command: string;
  ok: boolean;
  output: string;
}

export interface InstallPluginResult {
  ok: boolean;
  steps: InstallPluginStep[];
  error: string | null;
}

/** A real, disclosed bug caught by this milestone's own live daemon
 * check (not a test -- the earlier per-step `label` argument already
 * spelled out the full command, e.g. "claude plugin marketplace add",
 * and this line used to append `args.join(" ")` on top of it, producing
 * a visibly doubled `command` string in the real API response). `cliName`
 * is just the bare CLI name now; the full command is built once, here,
 * from it and `args` alone. */
async function runStep(prefix: string[], args: string[], cliName: string): Promise<InstallPluginStep> {
  const command = `${cliName} ${args.join(" ")}`;
  try {
    const { stdout, stderr } = await execFileAsync(prefix[0] as string, [...prefix.slice(1), ...args], { timeout: 60_000 });
    return { command, ok: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { command, ok: false, output: (e.stderr || e.stdout || e.message || String(err)).trim() };
  }
}

/** Runs the real, per-CLI plugin-install sequence documented above.
 * Never throws -- a failed step just stops the sequence and reports
 * `ok: false` with every step attempted so far, the same
 * never-throws-a-real-subprocess-failure convention `doctor()`/
 * `checkModel()` already follow in this package. */
export async function installPlugin(cli: Cli, cliPath: string): Promise<InstallPluginResult> {
  const prefix = cliArgvPrefix(cliPath);
  const steps: InstallPluginStep[] = [];

  switch (cli) {
    case "claude": {
      const s1 = await runStep(prefix, ["plugin", "marketplace", "add", MARKETPLACE_REPO], "claude");
      steps.push(s1);
      if (!s1.ok) return { ok: false, steps, error: "adding the marketplace failed" };
      const s2 = await runStep(prefix, ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "-y"], "claude");
      steps.push(s2);
      return { ok: s2.ok, steps, error: s2.ok ? null : "installing the plugin failed" };
    }
    case "copilot": {
      const s1 = await runStep(prefix, ["plugin", "marketplace", "add", MARKETPLACE_REPO], "copilot");
      steps.push(s1);
      if (!s1.ok) return { ok: false, steps, error: "adding the marketplace failed" };
      const s2 = await runStep(prefix, ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], "copilot");
      steps.push(s2);
      return { ok: s2.ok, steps, error: s2.ok ? null : "installing the plugin failed" };
    }
    case "codex": {
      const s1 = await runStep(prefix, ["plugin", "marketplace", "add", MARKETPLACE_REPO], "codex");
      steps.push(s1);
      if (!s1.ok) return { ok: false, steps, error: "adding the marketplace failed" };
      const s2 = await runStep(prefix, ["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], "codex");
      steps.push(s2);
      return { ok: s2.ok, steps, error: s2.ok ? null : "installing the plugin failed" };
    }
    case "agy": {
      const s1 = await runStep(prefix, ["plugin", "install", `https://github.com/${MARKETPLACE_REPO}`], "agy");
      steps.push(s1);
      return { ok: s1.ok, steps, error: s1.ok ? null : "installing the plugin failed" };
    }
  }
}
