import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Cli } from "./types.js";
import { cliArgvPrefix } from "./cli-paths.js";

const execFileAsync = promisify(execFile);

/** Model-listing command per CLI, argv after the CLI's own path. VERIFY:
 * only agy's was confirmed (`agy models`, real output inspected); `claude
 * --help`, `codex --help` and `copilot help commands` show no equivalent
 * for any of the other three. Ported from
 * crewbench_env.py's MODEL_LIST_COMMANDS.
 *
 * Re-verified 2026-09-20 against real installed binaries (not just
 * re-reading this comment) for the app's own model-picker dropdown
 * (`GET /api/models/:cli`): `claude --help`'s `--model` flag only
 * documents a few alias examples inline ("fable", "opus", "sonnet"), not
 * an enumerable, machine-readable list, and no subcommand lists models;
 * `codex --help` likewise has `-m, --model <MODEL>` with no listing
 * subcommand anywhere in its command tree; `copilot --help` and
 * `copilot help commands` both confirm `/model` is an *interactive*
 * slash command usable only inside a live TUI session, not a
 * non-interactive CLI invocation this could shell out to. Still true. */
const MODEL_LIST_COMMANDS: Partial<Record<Cli, string[]>> = { agy: ["models"] };

export interface CheckModelResult {
  cli: Cli;
  model: string;
  checked: boolean;
  found: boolean | null;
  closest: string[];
  available: string[];
  error: string | null;
}

async function listModels(cli: Cli, cliPath: string): Promise<{ ids: string[] | null; error: string | null }> {
  const args = MODEL_LIST_COMMANDS[cli];
  if (!args) {
    return { ids: null, error: `no model-listing command is known for ${cli} (see MODEL_LIST_COMMANDS)` };
  }
  const prefix = cliArgvPrefix(cliPath);
  try {
    const { stdout } = await execFileAsync(prefix[0] as string, [...prefix.slice(1), ...args], { timeout: 20_000 });
    const ids: string[] = [];
    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.toLowerCase().startsWith("fetching")) continue; // agy's progress line
      ids.push(line.split("\t")[0]!.trim());
    }
    return { ids, error: null };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ids: null, error: (e.stderr || e.stdout || e.message || String(err)).trim() };
  }
}

export interface AvailableModelsResult {
  checked: boolean;
  available: string[];
  error: string | null;
}

/** The app's own model-picker dropdown (`GET /api/models/:cli`, not part
 * of the original doctor/check-model flow this file was built for) needs
 * the plain list without also checking one specific model against it --
 * this is `listModels()` above, made public and never-throwing the same
 * way `checkModel()` already is, rather than that private helper growing
 * a second call site with its own error handling. */
export async function listAvailableModels(cli: Cli, cliPath: string): Promise<AvailableModelsResult> {
  const { ids, error } = await listModels(cli, cliPath);
  return { checked: ids !== null, available: ids ?? [], error };
}

/** Whether `model` is a real id this CLI currently lists, plus the closest
 * available ids when it isn't -- never throws; a CLI with no listing
 * command just comes back `checked: false`. Ported field-for-field from
 * crewbench_env.py's check_model(). */
export async function checkModel(cli: Cli, cliPath: string, model: string): Promise<CheckModelResult> {
  const { ids: available, error } = await listModels(cli, cliPath);
  if (available === null) {
    return { cli, model, checked: false, found: null, closest: [], available: [], error };
  }
  const found = available.includes(model);
  let closest: string[] = [];
  if (!found) {
    // A tier default like "gemini-3.8-flash" is often a bare prefix of the
    // CLI's real, effort-suffixed ids ("gemini-3.8-flash-medium"); prefer
    // that relationship over generic string-similarity matching.
    closest = available.filter((m) => m.startsWith(model + "-")).slice(0, 3);
    if (closest.length === 0) {
      closest = closeMatches(model, available, 3, 0.4);
    }
  }
  return { cli, model, checked: true, found, closest, available, error: null };
}

/** A small stand-in for Python's difflib.get_close_matches(): ranks
 * candidates by normalized Levenshtein similarity, keeping those at or
 * above `cutoff`. Not byte-identical to difflib's ratio algorithm (that's
 * SequenceMatcher's specific ratio, not plain edit distance) -- this is
 * best-effort fuzzy matching for a doctor-report hint, not something
 * anything else depends on for correctness. */
function closeMatches(target: string, candidates: string[], n: number, cutoff: number): string[] {
  const scored = candidates
    .map((candidate) => ({ candidate, score: similarity(target, candidate) }))
    .filter(({ score }) => score >= cutoff)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map(({ candidate }) => candidate);
}

function similarity(a: string, b: string): number {
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, (_, i) => [i, ...new Array<number>(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) dist[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(dist[i - 1]![j]! + 1, dist[i]![j - 1]! + 1, dist[i - 1]![j - 1]! + cost);
    }
  }
  return dist[rows - 1]![cols - 1]!;
}
