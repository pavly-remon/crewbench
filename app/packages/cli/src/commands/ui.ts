import { spawn } from "node:child_process";
import { startDaemon } from "@crewbench/daemon";

/** `crewbench ui [--port N] [--no-open]` -- starts the daemon and opens
 * the browser with the auth token in the URL fragment
 * (docs/app/phase-2-plan.md's Design decision 7: a fragment, not a query
 * param, so the token is never sent to the server or logged in access
 * logs/history the way a query param would be). The UI's own bootstrap
 * JS is responsible for reading `location.hash` once and stripping it
 * (Phase 2 milestone 3, not this command's job). */
export async function uiCommand(argv: string[]): Promise<void> {
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : undefined;
  const noOpen = argv.includes("--no-open");

  const daemon = await startDaemon(port === undefined ? {} : { port });
  const url = `http://127.0.0.1:${daemon.port}/#token=${daemon.token}`;
  console.log(`crewbench ui running at http://127.0.0.1:${daemon.port}`);
  console.log(url);

  if (!noOpen) {
    openBrowser(url);
  }

  const shutdown = () => {
    daemon
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? ["", url] : [url];
  try {
    spawn(command, args, { shell: platform === "win32", stdio: "ignore", detached: true }).unref();
  } catch {
    // Best-effort only -- the printed URL above is the fallback.
  }
}
