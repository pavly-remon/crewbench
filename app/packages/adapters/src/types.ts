import type { RoleName } from "@crewbench/contract";

export const CLI_NAMES = ["claude", "codex", "agy", "copilot"] as const;
export type Cli = (typeof CLI_NAMES)[number];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "none";
export type Permissions = "safe" | "skip";

/** Ported from crewbench_dispatch.py's ROLES dict -- role name -> role
 * brief filename under <root>/agents/. */
export const ROLE_BRIEF_FILES: Record<RoleName, string> = {
  developer: "developer.md",
  tester: "tester.md",
  "code-reviewer": "code-reviewer.md",
  "ui-ux": "ui-ux-designer.md",
};

export const READ_ONLY_ROLES: ReadonlySet<RoleName> = new Set(["code-reviewer"]);

/** One classified line from a running role's output -- mirrors
 * crewbench_dispatch.py's classify_log_entry() event types (see
 * docs/app/contract/events.md). `text` is the same human-readable string
 * that goes into the `.log` file. */
export type NormalizedEventType = "run.message" | "run.tool_call" | "run.tool_error";
export interface NormalizedEvent {
  type: NormalizedEventType;
  text: string;
}

export interface Usage {
  duration_s: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
}

/** What buildCommand() returns: the argv, the text to write to stdin (or
 * null if this CLI takes the prompt as a file pointer instead), and an
 * optional extra output file this CLI writes and that must be read back
 * after the run finishes (codex's structured result, copilot's real usage
 * -- see build-command.ts's per-CLI docstrings). */
export interface BuildCommandResult {
  argv: string[];
  stdin: string | null;
  extraOutputFile: string | null;
}

export interface BuildCommandArgs {
  role: RoleName;
  cli: Cli;
  model: string;
  effort: Effort;
  skipPermissions: boolean;
  cwd: string;
  timeoutS: number;
  /** agy conversation id to resume, for the denied-command-resume flow. */
  conversation?: string;
}

export interface DoctorReport {
  cli: Cli;
  installed: boolean;
  version: string | null;
  config_dir: string | null;
  config_dir_writable: boolean | null;
  network_ok: boolean | null;
  network_detail: string | null;
  logged_in: boolean | null;
  auth_detail: string | null;
  ok: boolean;
  errors: string[];
}

export interface ParsedOutput {
  result: unknown;
  permissionDenials: unknown[];
  error: string | null;
}
