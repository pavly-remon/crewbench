import type { Cli } from "./types.js";

/** Ported field-for-field from crewbench_dispatch.py's resume_command(). */
export function resumeCommand(cli: Cli, sessionId: string | null): string | null {
  if (!sessionId) {
    return cli === "copilot" ? "copilot --continue" : null;
  }
  switch (cli) {
    case "claude":
      return `claude --resume ${sessionId}`;
    case "agy":
      return `agy --conversation ${sessionId}`;
    case "codex":
      // Confirmed live: `codex resume <id>` launches the interactive TUI;
      // the headless equivalent is `codex exec resume <id>`.
      return `codex exec resume ${sessionId}`;
    case "copilot":
      return `copilot --resume=${sessionId}`;
  }
}
