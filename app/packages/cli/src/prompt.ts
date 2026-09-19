import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Thin readline wrapper for the CLI's interactive approval prompts
 * (docs/app/phase-1-plan.md's milestone 5: "approvals resolved via
 * terminal prompts"). Kept as a single small module so a future daemon/UI
 * (Phase 2+) can swap this out for a real approval-request/response flow
 * without touching the engine or command logic that calls it. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n] " : "[y/N] ";
  const answer = (await ask(`${question} ${suffix}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}
