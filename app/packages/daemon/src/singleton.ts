/** Phase 4 milestone 4 (Design decision 4, finding 5): before this,
 * `findOpenPort()` silently walked forward to the next free port when
 * the preferred one was busy -- including when it was busy because
 * *another crewbench daemon* was already listening there, quietly
 * starting a second, fully independent daemon process instead of
 * refusing. Both would read/write the same `~/.crewbench/projects.json`
 * (now locked, `registry.ts`'s own fix, but still two daemons racing
 * each other's in-memory task state and SSE watchers is not something
 * locking alone fixes). This module answers one question up front:
 * "is a real crewbench daemon, not just some unrelated process, already
 * listening on this exact port" -- and only refuses to start when the
 * answer is genuinely yes. */

/** A liveness marker any real crewbench daemon serves, unauthenticated
 * (it's outside `/api/`, the same exemption `auth.ts` already gives
 * static UI assets -- see that file's own docstring for why: the page
 * has to load before it can even read the token out of the URL). Not a
 * secret, not a capability -- just "yes, a crewbench daemon answered." */
export const LIVENESS_PATH = "/__crewbench_daemon__";
export const LIVENESS_MARKER = "crewbench-daemon";

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly port: number) {
    super(`a crewbench daemon is already running at http://127.0.0.1:${port}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

/** True only if a real crewbench daemon answers `LIVENESS_PATH` on
 * `port` right now. A short timeout and a broad catch are both
 * deliberate: an unrelated service on that port (anything from a plain
 * refused connection to a slow, unrelated HTTP server that never
 * responds) must read as "not a crewbench daemon," not hang or crash
 * this check -- `findOpenPort()`'s own existing forward-scan is still
 * the correct behavior for a port that's merely occupied by something
 * else. */
export async function probeExistingDaemon(port: number, timeoutMs = 300): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${LIVENESS_PATH}`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { marker?: string };
    return body.marker === LIVENESS_MARKER;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
