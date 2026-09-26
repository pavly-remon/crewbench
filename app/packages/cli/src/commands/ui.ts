import { spawn } from "node:child_process";
import { startDaemon, DaemonAlreadyRunningError } from "@crewbench/daemon";

/** `crewbench ui [--port N] [--no-open]` -- starts the daemon and opens
 * the browser with the auth token in the URL fragment
 * (docs/app/phase-2-plan.md's Design decision 7: a fragment, not a query
 * param, so the token is never sent to the server or logged in access
 * logs/history the way a query param would be). The UI's own bootstrap
 * JS is responsible for reading `location.hash` once and stripping it
 * (Phase 2 milestone 3, not this command's job).
 *
 * Phase 4 milestone 4 (Design decision 4): `startDaemon()` itself refuses
 * to start a second daemon on the same preferred port -- caught here as
 * a clean, expected outcome (exit 0, not a crash), not an error to
 * surface with a stack trace. This process has no way to know the
 * already-running daemon's own token (Phase 2's "never persisted"
 * principle, unchanged), so it can only point at the URL, not open an
 * already-authenticated tab -- a real, disclosed limitation, not an
 * oversight. */
export async function uiCommand(argv: string[]): Promise<void> {
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : undefined;
  const noOpen = argv.includes("--no-open");

  let daemon;
  try {
    daemon = await startDaemon(port === undefined ? {} : { port });
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      console.log(`crewbench ui is already running at http://127.0.0.1:${err.port}`);
      console.log("Open that URL in your browser, or switch to its existing tab.");
      return;
    }
    throw err;
  }
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
