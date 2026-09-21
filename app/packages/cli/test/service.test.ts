import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real, hard safety constraint for this test file (Phase 4 milestone 4):
// never let a real launchctl/systemctl/schtasks process spawn on this
// machine. `node:child_process`'s `execFile` is mocked at the module
// level, before `../src/commands/service.ts` is ever imported (its own
// `execFileAsync = promisify(execFile)` captures this mock, not a real
// child_process), so every "registration command" in every test below is
// a recorded call, never a real subprocess.
const execFileCalls: Array<{ argv0: string; args: string[] }> = [];
vi.mock("node:child_process", () => ({
  execFile: (argv0: string, args: string[], callback: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    execFileCalls.push({ argv0, args });
    callback(null, { stdout: "", stderr: "" });
  },
}));

const { installService, uninstallService, registrationCommand, generateLaunchdPlist, generateSystemdUnit, generateWindowsTaskXml, detectServiceTarget } =
  await import("../src/commands/service.js");

describe("crewbench service install|uninstall (Phase 4 milestone 4)", () => {
  const savedEnv = { ...process.env };
  const savedArgv = [...process.argv];

  beforeEach(async () => {
    execFileCalls.length = 0;
    process.env.CREWBENCH_SERVICE_HOME = await mkdtemp(join(tmpdir(), "crewbench-service-home-"));
    process.argv[1] = "/fake/path/to/crewbench/bin.js"; // what installService() captures as binPath
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.argv.length = 0;
    process.argv.push(...savedArgv);
  });

  describe("generation logic (pure, no filesystem or subprocess)", () => {
    it("launchd plist: real, well-formed XML pointing at the exact node/bin invocation, with --no-open", () => {
      const xml = generateLaunchdPlist("/usr/bin/node", "/path/to/bin.js");
      expect(xml).toContain("<string>/usr/bin/node</string>");
      expect(xml).toContain("<string>/path/to/bin.js</string>");
      expect(xml).toContain("<string>ui</string>");
      expect(xml).toContain("<string>--no-open</string>");
      expect(xml).toContain("<key>RunAtLoad</key>");
      expect(xml).toContain("com.crewbench.ui");
    });

    it("systemd unit: real ExecStart line with both the node and bin paths, and a user-target install", () => {
      const unit = generateSystemdUnit("/usr/bin/node", "/path/to/bin.js");
      expect(unit).toContain("ExecStart=/usr/bin/node /path/to/bin.js ui --no-open");
      expect(unit).toContain("WantedBy=default.target");
    });

    it("windows task XML: a real LogonTrigger action running node against bin.js", () => {
      const xml = generateWindowsTaskXml("C:\\node.exe", "C:\\bin.js");
      expect(xml).toContain("<LogonTrigger>");
      expect(xml).toContain("<Command>C:\\node.exe</Command>");
      expect(xml).toContain('"C:\\bin.js" ui --no-open');
    });

    it("registrationCommand() returns real, correct argv per target -- never executes anything itself", () => {
      expect(registrationCommand("launchd", "install")).toMatchObject({ argv0: "launchctl", args: expect.arrayContaining(["load"]) });
      expect(registrationCommand("launchd", "uninstall")).toMatchObject({ argv0: "launchctl", args: expect.arrayContaining(["unload"]) });
      expect(registrationCommand("systemd", "install")).toMatchObject({ argv0: "systemctl", args: expect.arrayContaining(["enable"]) });
      expect(registrationCommand("systemd", "uninstall")).toMatchObject({ argv0: "systemctl", args: expect.arrayContaining(["disable"]) });
      expect(registrationCommand("windows-task-scheduler", "install")).toMatchObject({ argv0: "schtasks", args: expect.arrayContaining(["/create"]) });
      expect(registrationCommand("windows-task-scheduler", "uninstall")).toMatchObject({ argv0: "schtasks", args: expect.arrayContaining(["/delete"]) });
    });

    it("detectServiceTarget() returns one of the three real targets for this real platform", () => {
      expect(["launchd", "systemd", "windows-task-scheduler"]).toContain(detectServiceTarget());
    });
  });

  describe("installService()/uninstallService() -- real file writes to a sandboxed CREWBENCH_SERVICE_HOME, mocked OS registration", () => {
    it("writes a real, real-content service-config file for this platform's own target", async () => {
      const result = await installService();
      expect(existsSync(result.configPath)).toBe(true);
      const content = readFileSync(result.configPath, "utf-8");
      expect(content).toContain("bin.js");
      // Real confirmation the file lives under the sandboxed home, not
      // this machine's real ~/Library/LaunchAgents or ~/.config/systemd.
      expect(result.configPath.startsWith(process.env.CREWBENCH_SERVICE_HOME as string)).toBe(true);
    });

    it("calls the mocked registration command exactly once, with the real target-appropriate argv -- never a real launchctl/systemctl/schtasks", async () => {
      await installService();
      expect(execFileCalls).toHaveLength(1);
      const target = detectServiceTarget();
      const expectedArgv0 = target === "launchd" ? "launchctl" : target === "systemd" ? "systemctl" : "schtasks";
      expect(execFileCalls[0]?.argv0).toBe(expectedArgv0);
    });

    it("uninstall removes the real config file it wrote and calls the mocked unregistration command", async () => {
      const installed = await installService();
      expect(existsSync(installed.configPath)).toBe(true);
      execFileCalls.length = 0;

      const removed = await uninstallService();
      expect(existsSync(removed.configPath)).toBe(false);
      expect(execFileCalls).toHaveLength(1);
    });

    it("uninstall is safe to call even when nothing was ever installed (no config file exists)", async () => {
      const result = await uninstallService();
      expect(existsSync(result.configPath)).toBe(false); // was never there, still isn't -- no throw
      expect(execFileCalls).toHaveLength(1); // the (mocked) unregistration command still runs -- OS-level idempotency is that layer's job, not this one's
    });
  });
});
