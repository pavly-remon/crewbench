#!/usr/bin/env node
import { findRoot } from "./root.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { resumeCommand } from "./commands/resume.js";
import { doctorCommand } from "./commands/doctor.js";
import { teamCommand } from "./commands/team.js";
import { profileCommand } from "./commands/profile.js";
import { uiCommand } from "./commands/ui.js";
import { closePrompt } from "./prompt.js";

const USAGE = `crewbench -- run the crewbench workflow headlessly

Usage:
  crewbench run "<task description>" [--yes] [--design] [--in-place]
                [--rounds N] [--dev cli[:model]] [--review cli[:model]]
  crewbench status [task-id]
  crewbench resume [task-id]
  crewbench doctor [--cli claude|codex|agy|copilot]
  crewbench team [show]
  crewbench profile [show|refresh]
  crewbench ui [--port N] [--no-open]
`;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  const root = findRoot();
  switch (command) {
    case "run":
      await runCommand(rest, root);
      return;
    case "status":
      await statusCommand(rest);
      return;
    case "resume":
      await resumeCommand(rest, root);
      return;
    case "doctor":
      await doctorCommand(rest);
      return;
    case "team":
      await teamCommand(rest, root);
      return;
    case "profile":
      await profileCommand(rest);
      return;
    case "ui":
      await uiCommand(rest);
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closePrompt());
