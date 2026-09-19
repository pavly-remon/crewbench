import { join } from "node:path";
import { resolveLineup } from "../lineup.js";
import { defaultsPath } from "../root.js";
import type { Cli } from "@crewbench/adapters";

/** `crewbench team [show]` -- ported in spirit from skills/team/SKILL.md.
 * Only `show` is implemented this milestone (prints the resolved lineup);
 * `set` (editing .crewbench/team.json interactively) is a straightforward
 * follow-up once the UI/daemon phases give it a better home than a bare
 * terminal prompt sequence. */
export async function teamCommand(argv: string[], root: string): Promise<void> {
  const sub = argv[0] ?? "show";
  if (sub !== "show") {
    throw new Error(`unknown team subcommand: ${sub} (only "show" is implemented so far)`);
  }
  const projectRoot = process.cwd();
  const hostCli = (process.env.CREWBENCH_LEAD as Cli | undefined) ?? "claude";
  const lineup = await resolveLineup(defaultsPath(root), projectRoot, hostCli);
  console.log(JSON.stringify(lineup, null, 2));
  console.log(`\n(team.json, if any: ${join(projectRoot, ".crewbench", "team.json")})`);
}
