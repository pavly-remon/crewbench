import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleName } from "@crewbench/contract";
import type { Cli } from "./types.js";
import { READ_ONLY_ROLES } from "./types.js";

const GIT_RULE =
  "Never commit, push or otherwise change git history or branches — leave changes " +
  "uncommitted; the Team Lead commits after the user confirms.";

/** Ported field-for-field from crewbench_dispatch.py's LIMITS. */
export const LIMITS: Record<RoleName, string> = {
  developer: "You may read and edit files in the project and run shell commands. " + GIT_RULE,
  tester:
    "You may read files, add or edit test files, and run shell commands. Do not change " +
    "non-test source code. " +
    GIT_RULE,
  "code-reviewer": "You are read-only: do not edit files or run commands that change anything.",
  "ui-ux": "You may read files and write design documents. Do not run shell commands or write implementation code.",
};

/** Ported from crewbench_dispatch.py's CLAUDE_TOOLS. */
export const CLAUDE_TOOLS: Record<RoleName, string> = {
  developer: "Read,Write,Edit,Bash,Grep,Glob",
  tester: "Read,Write,Edit,Bash,Grep,Glob",
  "code-reviewer": "Read,Grep,Glob",
  "ui-ux": "Read,Write,Edit,Grep,Glob",
};

export const AGY_FILE_TOOLS =
  "Use your built-in file tools — view_file, list_dir, find_by_name, grep_search, " +
  "replace_file_content, write_to_file — to read, search and edit. Never use shell " +
  "commands such as ls, cat, head, tail, find, grep or sed for that.";

/** Return {usable, broken} command rules from the user's agy allow list.
 * agy matches command(...) targets as literal word-by-word prefixes; `*`
 * only works alone (command(*)), so a rule like command(ls*) never
 * matches `ls`. Ported field-for-field from
 * crewbench_dispatch.py's agy_command_rules(). Accepts an optional `home`
 * override for testing (mirrors the Python test suite's
 * `monkeypatch.setattr(Path, "home", ...)`). */
export function agyCommandRules(home: string = homedir()): { usable: string[]; broken: string[] } {
  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  let rules: unknown[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const allow = isPlainObject(parsed) && isPlainObject(parsed.permissions) ? parsed.permissions.allow : undefined;
    rules = Array.isArray(allow) ? allow : [];
  } catch {
    return { usable: [], broken: [] };
  }

  const usable: string[] = [];
  const broken: string[] = [];
  for (const rule of rules) {
    if (typeof rule !== "string" || !rule.startsWith("command(") || !rule.endsWith(")")) continue;
    const target = rule.slice("command(".length, -1);
    if (target !== "*" && target.includes("*") && !target.startsWith("regex:")) {
      broken.push(rule);
    } else {
      usable.push(target);
    }
  }
  return { usable, broken };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ported field-for-field from crewbench_dispatch.py's limits_for(). */
export function limitsFor(role: RoleName, cli: Cli, skip = false): string {
  let text = LIMITS[role];
  if (cli === "agy") {
    text += "\n\n" + AGY_FILE_TOOLS;
    if (!READ_ONLY_ROLES.has(role) && role !== "ui-ux" && !skip) {
      const { usable } = agyCommandRules();
      let allowed: string;
      if (usable.includes("*")) {
        allowed = "any command";
      } else if (usable.length > 0) {
        allowed = usable
          .map((t) => (t.startsWith("regex:") ? `\`${t.slice("regex:".length)}\` (regex)` : `\`${t}\` (and \`${t} ...\`)`))
          .join(", ");
      } else {
        allowed = "none";
      }
      text +=
        "\n\nShell commands are restricted in this run. Only these commands are allowed: " +
        allowed +
        '. Any other command is denied. Don\'t run it or a variant of it — if you truly need ' +
        'it (e.g. to run tests), list it under "blocked" and carry on.';
    }
  }
  if (cli === "copilot" && (role === "developer" || role === "tester") && !skip) {
    text += '\n\nShell commands are not available in this run; list any you needed under "blocked".';
  }
  return text;
}
