import { CLI_NAMES, createAdapter } from "@crewbench/adapters";

/** `crewbench doctor [--cli X]` -- runs the same doctor checks
 * lib/dispatch.md's "Sandboxes and doctor" section describes, for one CLI
 * or all four. */
export async function doctorCommand(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--cli");
  const only = idx >= 0 ? argv[idx + 1] : null;
  const targets = only ? [only] : CLI_NAMES;

  let allOk = true;
  for (const cli of targets) {
    if (!CLI_NAMES.includes(cli as (typeof CLI_NAMES)[number])) {
      console.log(`${cli}: unknown CLI (expected one of ${CLI_NAMES.join(", ")})`);
      allOk = false;
      continue;
    }
    const report = await createAdapter(cli as (typeof CLI_NAMES)[number]).doctor();
    console.log(`${cli}: ${report.ok ? "ok" : "FAILED"}`);
    console.log(`  installed: ${report.installed}  version: ${report.version ?? "?"}`);
    console.log(`  config_dir: ${report.config_dir} (writable: ${report.config_dir_writable})`);
    console.log(`  network: ${report.network_ok} (${report.network_detail ?? ""})`);
    console.log(`  logged_in: ${report.logged_in} (${report.auth_detail ?? ""})`);
    for (const error of report.errors) console.log(`  error: ${error}`);
    allOk &&= report.ok;
  }
  if (!allOk) process.exitCode = 1;
}
