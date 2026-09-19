import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFixtureDaemon, writeFixtureFile } from "./fixture-server.js";

export const FIXTURE_PATH = join(tmpdir(), "crewbench-e2e-fixture.json");

/** Runs in Playwright's own long-lived orchestrator process (not a
 * worker), so the daemon started here stays reachable on its real TCP
 * port for the whole test run even though individual test files run in
 * separate worker processes -- returning a teardown function (rather
 * than a separate `globalTeardown` config entry) keeps the `DaemonHandle`
 * reference in one closure instead of needing to serialize it across
 * processes, which isn't possible for a live server handle anyway. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const { daemon, fixture } = await startFixtureDaemon();
  await writeFixtureFile(FIXTURE_PATH, fixture);
  return async () => {
    await daemon.close();
  };
}
