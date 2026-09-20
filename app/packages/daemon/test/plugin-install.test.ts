import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";

/** A fake CLI standing in for claude/codex/copilot/agy's real plugin
 * commands -- this test never spawns a real CLI binary (see this
 * milestone's own plan log for why: a real `agy plugin install` was
 * accidentally run against this machine's own live config during this
 * milestone's investigation phase, a real incident, disclosed there, not
 * repeated here). Records every invocation's argv to `recordPath` (one
 * JSON line per call) and exits non-zero for any call whose argv
 * (space-joined) contains `failOn`, so a test can force a specific real
 * step (e.g. "marketplace") to fail and confirm the sequence stops
 * there. */
async function fakePluginCli(failOn: string | null = null): Promise<{ path: string; recordPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-daemon-plugincli-"));
  const path = join(dir, "fake-cli.cjs");
  const recordPath = join(dir, "calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(argv) + "\\n");
const joined = argv.join(" ");
const failOn = ${JSON.stringify(failOn)};
if (failOn && joined.includes(failOn)) {
  process.stderr.write("simulated failure for: " + joined + "\\n");
  process.exit(1);
}
process.stdout.write("ok: " + joined + "\\n");
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return { path, recordPath };
}

async function readCalls(recordPath: string): Promise<string[][]> {
  const raw = await readFile(recordPath, "utf-8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe("POST /api/plugin-install/:cli", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };
  // Real, pre-existing isolation gap fixed here -- see
  // test/fs-browse.test.ts's own comment for the full story
  // (`daemonHome()` defaults to the real `~/.crewbench` without this) --
  // an especially real risk for *this* file, since a `startDaemon()`
  // that read a real, populated `~/.crewbench/projects.json` could have
  // its own `reattachProject()` genuinely re-drive a real task.
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-plugininstall-home-"));
    process.env.CREWBENCH_HOME = home;
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  it("400s for an unknown cli name", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/plugin-install/not-a-real-cli"), { method: "POST", headers });
    expect(res.status).toBe(400);
  });

  it("400s when the cli isn't found on PATH", async () => {
    process.env.PATH = "";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/plugin-install/agy"), { method: "POST", headers });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("PATH");
  });

  it("claude: runs marketplace add then plugin install, in order, with the real argv this milestone's own investigation confirmed", async () => {
    const { path, recordPath } = await fakePluginCli();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = path;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };

    const res = await fetch(url("/api/plugin-install/claude"), { method: "POST", headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cli: string; ok: boolean; steps: Array<{ ok: boolean; command: string }>; error: string | null };
    expect(body.ok).toBe(true);
    expect(body.steps).toHaveLength(2);
    expect(body.steps.every((s) => s.ok)).toBe(true);
    expect(body.error).toBeNull();
    // A real bug this milestone's own live daemon check (not a test)
    // caught: `command` used to render doubled, e.g. "claude plugin
    // marketplace add plugin marketplace add pavly-remon/crewbench".
    expect(body.steps[0]!.command).toBe("claude plugin marketplace add pavly-remon/crewbench");
    expect(body.steps[1]!.command).toBe("claude plugin install crewbench@PiCode-marketplace -y");

    const calls = await readCalls(recordPath);
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", "pavly-remon/crewbench"],
      ["plugin", "install", "crewbench@PiCode-marketplace", "-y"],
    ]);
  });

  it("copilot: runs marketplace add then plugin install, no -y flag (matches its own real --help)", async () => {
    const { path, recordPath } = await fakePluginCli();
    process.env.CREWBENCH_CLI_OVERRIDE_COPILOT = path;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };

    const res = await fetch(url("/api/plugin-install/copilot"), { method: "POST", headers });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const calls = await readCalls(recordPath);
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", "pavly-remon/crewbench"],
      ["plugin", "install", "crewbench@PiCode-marketplace"],
    ]);
  });

  it("codex: runs marketplace add then plugin add (not 'plugin install')", async () => {
    const { path, recordPath } = await fakePluginCli();
    process.env.CREWBENCH_CLI_OVERRIDE_CODEX = path;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };

    const res = await fetch(url("/api/plugin-install/codex"), { method: "POST", headers });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const calls = await readCalls(recordPath);
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", "pavly-remon/crewbench"],
      ["plugin", "add", "crewbench@PiCode-marketplace"],
    ]);
  });

  it("agy: a single step, the real GitHub URL form, no marketplace step at all", async () => {
    const { path, recordPath } = await fakePluginCli();
    process.env.CREWBENCH_CLI_OVERRIDE_AGY = path;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };

    const res = await fetch(url("/api/plugin-install/agy"), { method: "POST", headers });
    const body = (await res.json()) as { ok: boolean; steps: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.steps).toHaveLength(1);

    const calls = await readCalls(recordPath);
    expect(calls).toEqual([["plugin", "install", "https://github.com/pavly-remon/crewbench"]]);
  });

  it("stops after the marketplace step fails -- the install step never runs", async () => {
    const { path, recordPath } = await fakePluginCli("marketplace");
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = path;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };

    const res = await fetch(url("/api/plugin-install/claude"), { method: "POST", headers });
    expect(res.status).toBe(200); // the HTTP call itself succeeds -- ok:false in the body reports the real failure
    const body = (await res.json()) as { ok: boolean; steps: Array<{ ok: boolean }>; error: string | null };
    expect(body.ok).toBe(false);
    expect(body.steps).toHaveLength(1); // only the failed marketplace step -- install was never attempted
    expect(body.steps[0]!.ok).toBe(false);
    expect(body.error).toBe("adding the marketplace failed");

    const calls = await readCalls(recordPath);
    expect(calls).toHaveLength(1);
  });

  it("reports a real failed install step's own output, not a generic message", async () => {
    const { path } = await fakePluginCli("install");
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = path;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };

    const res = await fetch(url("/api/plugin-install/claude"), { method: "POST", headers });
    const body = (await res.json()) as { ok: boolean; steps: Array<{ ok: boolean; output: string }> };
    expect(body.ok).toBe(false);
    expect(body.steps).toHaveLength(2); // marketplace succeeded, install failed
    expect(body.steps[0]!.ok).toBe(true);
    expect(body.steps[1]!.ok).toBe(false);
    expect(body.steps[1]!.output).toContain("simulated failure");
  });
});
