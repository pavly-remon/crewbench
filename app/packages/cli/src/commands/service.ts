import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SERVICE_LABEL = "com.crewbench.ui";

/** Every path this module ever writes to or reads from, resolved once so
 * both the real command and its tests can override the "OS location"
 * without touching this machine's actual login-service directories.
 * `CREWBENCH_SERVICE_HOME` is a real, disclosed test-only override (same
 * `CREWBENCH_*`-prefixed pattern `CREWBENCH_HOME`/`CREWBENCH_ROOT` already
 * use elsewhere in this app) -- **the hard safety reason this exists at
 * all**: this milestone's own tests must never write into this real
 * machine's real `~/Library/LaunchAgents`, `~/.config/systemd/user`, or
 * invoke a real `schtasks`, so every test that exercises file generation
 * points this at a throwaway temp directory instead. */
function serviceHome(): string {
  return process.env.CREWBENCH_SERVICE_HOME ?? homedir();
}

function launchdPlistPath(): string {
  return join(serviceHome(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return join(serviceHome(), ".config", "systemd", "user", "crewbench-ui.service");
}

function windowsTaskXmlPath(): string {
  // Not a real Task Scheduler location (there isn't a per-user *file*
  // location the way launchd/systemd have -- `schtasks /create /xml`
  // takes an arbitrary source file path and imports its content into
  // the Task Scheduler's own internal store) -- this is just where the
  // generated XML is staged before being handed to `schtasks`, kept
  // under the same overridable `serviceHome()` so tests never need a
  // real Windows machine to exercise the generation logic.
  return join(serviceHome(), "crewbench-ui-task.xml");
}

/** `launchd` (macOS): a real, minimal `LaunchAgent` plist running
 * `<nodePath> <binPath> ui --no-open` at login and keeping it alive
 * (`KeepAlive`) -- `--no-open` since a login-time launch has no browser
 * session context to open a tab into (the phase prompt's own "runs at
 * login," not "opens a browser at login"). `nodePath`/`binPath` are both
 * absolute (`process.execPath`/the real running `bin.js`'s own path,
 * captured by `serviceCommand()` below) -- a login-time launchd
 * environment's `PATH` is not guaranteed to contain either `node` or a
 * global `crewbench` shim, so this can't rely on either being resolvable
 * by name. */
export function generateLaunchdPlist(nodePath: string, binPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${binPath}</string>
    <string>ui</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(serviceHome(), "Library", "Logs", "crewbench-ui.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(serviceHome(), "Library", "Logs", "crewbench-ui.log")}</string>
</dict>
</plist>
`;
}

/** `systemd` (Linux) user unit -- the same "start `crewbench ui --no-open`
 * at login, restart it if it dies" contract as the launchd plist above,
 * `systemd`'s own idiom for it (`WantedBy=default.target` in a *user*
 * unit means "when this user's own systemd instance starts," the
 * closest real equivalent to launchd's `RunAtLoad` in a login, not
 * system-boot, context). */
export function generateSystemdUnit(nodePath: string, binPath: string): string {
  return `[Unit]
Description=crewbench ui (background daemon)

[Service]
ExecStart=${nodePath} ${binPath} ui --no-open
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** Windows Task Scheduler: a real, minimal task definition XML
 * (`schtasks /create /xml <this file>` imports it) -- `LogonTrigger`
 * with no `UserId` scopes it to "this user's own logon," matching
 * launchd/systemd's own per-user scope rather than a machine-wide
 * scheduled task. */
export function generateWindowsTaskXml(nodePath: string, binPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>"${binPath}" ui --no-open</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
</Task>
`;
}

export type ServiceTarget = "launchd" | "systemd" | "windows-task-scheduler";

export function detectServiceTarget(): ServiceTarget {
  const p = platform();
  if (p === "darwin") return "launchd";
  if (p === "win32") return "windows-task-scheduler";
  return "systemd"; // linux and every other POSIX platform Node reports
}

interface RegistrationCommand {
  argv0: string;
  args: string[];
}

/** The real OS-registration command each target needs, *not run here* --
 * `serviceCommand()` below is the only caller, and per this milestone's
 * own hard safety constraint, that caller's real invocation is exercised
 * in every test via a mocked `node:child_process` (`vi.mock`), never a
 * genuine `execFile` against this actual machine's real login-service
 * infrastructure. Kept as plain data (argv, not a live subprocess call)
 * specifically so it's trivially mockable/assertable without any real
 * process ever spawning. */
export function registrationCommand(target: ServiceTarget, action: "install" | "uninstall"): RegistrationCommand {
  switch (target) {
    case "launchd":
      return action === "install"
        ? { argv0: "launchctl", args: ["load", "-w", launchdPlistPath()] }
        : { argv0: "launchctl", args: ["unload", "-w", launchdPlistPath()] };
    case "systemd":
      return action === "install"
        ? { argv0: "systemctl", args: ["--user", "enable", "--now", "crewbench-ui.service"] }
        : { argv0: "systemctl", args: ["--user", "disable", "--now", "crewbench-ui.service"] };
    case "windows-task-scheduler":
      return action === "install"
        ? { argv0: "schtasks", args: ["/create", "/tn", "crewbench-ui", "/xml", windowsTaskXmlPath(), "/f"] }
        : { argv0: "schtasks", args: ["/delete", "/tn", "crewbench-ui", "/f"] };
  }
}

export interface ServiceInstallResult {
  target: ServiceTarget;
  configPath: string;
  command: RegistrationCommand;
}

/** Writes the real, target-appropriate service-config file to its real
 * on-disk location (`serviceHome()`-scoped, see that function's own
 * docstring for why this is safely overridable in tests) and runs the
 * real OS registration command via `execFile` -- the actual "install"
 * this milestone's own scope calls for. Every test of this function
 * mocks `node:child_process`'s `execFile` (never lets a real one spawn)
 * and points `CREWBENCH_SERVICE_HOME` at a temp directory. */
export async function installService(): Promise<ServiceInstallResult> {
  const target = detectServiceTarget();
  const nodePath = process.execPath;
  const binPath = process.argv[1] as string;

  let configPath: string;
  let content: string;
  if (target === "launchd") {
    configPath = launchdPlistPath();
    content = generateLaunchdPlist(nodePath, binPath);
  } else if (target === "systemd") {
    configPath = systemdUnitPath();
    content = generateSystemdUnit(nodePath, binPath);
  } else {
    configPath = windowsTaskXmlPath();
    content = generateWindowsTaskXml(nodePath, binPath);
  }

  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, content, "utf-8");

  const command = registrationCommand(target, "install");
  await execFileAsync(command.argv0, command.args);

  return { target, configPath, command };
}

/** Symmetric with `installService()`: runs the real unregistration
 * command, then removes the config file it wrote (best-effort -- a file
 * that's already gone, e.g. a user who deleted it by hand, isn't an
 * error here). */
export async function uninstallService(): Promise<ServiceInstallResult> {
  const target = detectServiceTarget();
  const configPath = target === "launchd" ? launchdPlistPath() : target === "systemd" ? systemdUnitPath() : windowsTaskXmlPath();
  const command = registrationCommand(target, "uninstall");
  await execFileAsync(command.argv0, command.args);
  if (existsSync(configPath)) await rm(configPath, { force: true });
  return { target, configPath, command };
}

export async function serviceCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "install") {
    const result = await installService();
    console.log(`Installed a ${result.target} service at ${result.configPath}.`);
    console.log(`crewbench ui will now start automatically at login. Run "crewbench service uninstall" to remove it.`);
    return;
  }
  if (action === "uninstall") {
    const result = await uninstallService();
    console.log(`Removed the ${result.target} service (${result.configPath}).`);
    return;
  }
  console.error(`Usage: crewbench service install|uninstall`);
  process.exitCode = 1;
}
