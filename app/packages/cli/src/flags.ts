import type { Cli } from "@crewbench/adapters";

export interface RunFlags {
  yes: boolean;
  design: boolean;
  inPlace: boolean;
  rounds: number | null;
  dev: { cli: Cli; model?: string } | null;
  review: { cli: Cli; model?: string } | null;
  taskText: string;
}

const CLI_NAMES = new Set(["claude", "codex", "agy", "copilot"]);

function parseCliModel(value: string): { cli: Cli; model?: string } {
  const [cli, ...rest] = value.split(":");
  if (!cli || !CLI_NAMES.has(cli)) {
    throw new Error(`unknown CLI "${cli}" in --dev/--review value "${value}" (expected claude, codex, agy or copilot)`);
  }
  const model = rest.join(":");
  return model ? { cli: cli as Cli, model } : { cli: cli as Cli };
}

/** Parses `run`'s flags out of the raw argv the way
 * lib/dispatch.md §1's "Flags in $ARGUMENTS" table describes: strip a
 * flag (and its value token where noted) out of the text, leave an
 * unrecognized `--something` alone (it's probably part of the task text
 * itself), and treat what's left as the task description. */
export function parseRunFlags(argv: string[]): RunFlags {
  const flags: RunFlags = { yes: false, design: false, inPlace: false, rounds: null, dev: null, review: null, taskText: "" };
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--yes") {
      flags.yes = true;
    } else if (arg === "--design") {
      flags.design = true;
    } else if (arg === "--in-place") {
      flags.inPlace = true;
    } else if (arg === "--rounds") {
      const value = argv[++i];
      if (!value || Number.isNaN(Number.parseInt(value, 10))) {
        throw new Error("--rounds requires a positive integer argument");
      }
      flags.rounds = Number.parseInt(value, 10);
    } else if (arg === "--dev") {
      const value = argv[++i];
      if (!value) throw new Error("--dev requires a value, e.g. --dev agy:gemini-3.8-flash");
      flags.dev = parseCliModel(value);
    } else if (arg === "--review") {
      const value = argv[++i];
      if (!value) throw new Error("--review requires a value, e.g. --review codex");
      flags.review = parseCliModel(value);
    } else {
      remaining.push(arg);
    }
  }

  flags.taskText = remaining.join(" ").trim();
  return flags;
}

const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** Ported from lib/dispatch.md §0's "Optional: Jira as task input":
 * `^[A-Z][A-Z0-9]+-\d+$` against the first word of the flag-stripped task
 * text. */
export function extractJiraKey(taskText: string): { jiraKey: string | null; rest: string } {
  const firstWord = taskText.split(/\s+/, 1)[0] ?? "";
  if (JIRA_KEY_RE.test(firstWord)) {
    return { jiraKey: firstWord, rest: taskText.slice(firstWord.length).trim() };
  }
  return { jiraKey: null, rest: taskText };
}
