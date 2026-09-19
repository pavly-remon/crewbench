import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";

/** Thin readline wrapper for the CLI's interactive approval prompts
 * (docs/app/phase-1-plan.md's milestone 5: "approvals resolved via
 * terminal prompts"). Kept as a single small module so a future daemon/UI
 * (Phase 2+) can swap this out for a real approval-request/response flow
 * without touching the engine or command logic that calls it.
 *
 * **Reads lines via the interface's async iterator, not
 * `Interface.prototype.question()`.** A real bug, caught live during
 * Phase 1 milestone 7's end-to-end verification: with piped (non-TTY)
 * stdin, only the *first* sequential `rl.question()` call on a given
 * interface ever resolves -- every call after that hangs forever (or, in
 * some Node versions/timings, throws "readline was closed"), even though
 * the interface itself is still open and the remaining input is still
 * there to be read. This is a genuine limitation of
 * `readline`/`readline/promises`' `question()` method with non-TTY
 * input, not a mistake in how it was called (confirmed by isolating it
 * to a 3-line reproduction outside this codebase before writing this
 * fix). Iterating the interface's own `for await`-style async iterator
 * (`rl[Symbol.asyncIterator]()`) instead reads every line reliably, in
 * order, for both piped and real-terminal input -- this is what `ask()`
 * does below, printing the prompt text separately since the iterator
 * itself has no notion of a "question". */
let sharedInterface: Interface | null = null;
let lineIterator: AsyncIterator<string> | null = null;

function getIterator(): AsyncIterator<string> {
  if (!lineIterator) {
    sharedInterface = createInterface({ input: stdin, terminal: stdin.isTTY ?? false });
    lineIterator = sharedInterface[Symbol.asyncIterator]();
  }
  return lineIterator;
}

export async function ask(question: string): Promise<string> {
  stdout.write(question);
  const { value, done } = await getIterator().next();
  return done ? "" : value.trim(); // EOF (stdin closed with no more input): treat as an empty answer, same as pressing enter
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n] " : "[y/N] ";
  const answer = (await ask(`${question} ${suffix}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Closes the shared prompt interface, if one was ever created. Call once
 * the command is done -- never mid-command, and never per-question. */
export function closePrompt(): void {
  sharedInterface?.close();
  sharedInterface = null;
  lineIterator = null;
}
