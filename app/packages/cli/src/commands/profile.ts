import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectProfile } from "@crewbench/engine";
import { confirm } from "../prompt.js";

/** `crewbench profile [show|refresh]` -- ported in spirit from
 * skills/profile/SKILL.md. `show` prints the current
 * .crewbench/project.json (or says there isn't one); `refresh` re-detects
 * and asks before overwriting, same "never write silently" rule as
 * lib/dispatch.md §0's "Project profile" section. */
export async function profileCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "show";
  const projectRoot = process.cwd();
  const profilePath = join(projectRoot, ".crewbench", "project.json");

  if (sub === "show") {
    if (!existsSync(profilePath)) {
      console.log("No .crewbench/project.json yet. Run `crewbench profile refresh` to detect one.");
      return;
    }
    console.log(await readFile(profilePath, "utf-8"));
    return;
  }

  if (sub === "refresh") {
    const detected = await detectProfile(projectRoot);
    console.log(JSON.stringify(detected, null, 2));
    const yes = await confirm("Save this as the project profile?", true);
    if (!yes) {
      console.log("Not saved.");
      return;
    }
    const profile = { ...detected, confirmed: true, detected_at: new Date().toISOString() };
    await mkdir(join(projectRoot, ".crewbench"), { recursive: true });
    await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n", "utf-8");
    console.log("Saved.");
    return;
  }

  throw new Error(`unknown profile subcommand: ${sub} (expected show or refresh)`);
}
