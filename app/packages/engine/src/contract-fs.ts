import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;

/** UTC ISO-8601 with an explicit offset, e.g. "2026-09-18T14:03:22Z" --
 * matches bin/crewbench_fs.py's now_iso() exactly, so a task's
 * state.json/events.jsonl timestamps are the same format regardless of
 * which side (plugin or app) wrote them. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parses either this UTC format or the plugin's pre-Phase-0 naive-local
 * one ("YYYY-MM-DDTHH:MM:SS", no offset). Returns null for anything
 * unparseable, mirroring crewbench_fs.py's parse_legacy_or_utc(). */
export function parseLegacyOrUtc(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  if (ts.endsWith("Z")) {
    const parsed = new Date(ts);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  // No offset: treat as local time (new Date() on a bare
  // "YYYY-MM-DDTHH:MM:SS" string parses it as local time already).
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** How long a stale `.lock` file (left behind by a process that crashed
 * without releasing it) is trusted before this module assumes it's dead
 * and removes it. Node has no built-in equivalent of POSIX
 * fcntl.flock/Windows msvcrt.locking that releases automatically on
 * process exit -- see this module's top-of-file limitation note. */
const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 25;

/** Mutual exclusion across concurrent Node-side writers to the same file
 * (e.g. a tester run and a reviewer run finishing at nearly the same
 * moment, both appending to events.jsonl). Implemented as an exclusive
 * lockfile (atomic `open(path, "wx")`, which fails if the file already
 * exists), polled until free, with a staleness timeout as a safeguard
 * against a crashed holder. This is NOT the same lock primitive as the
 * Python side's fcntl.flock/msvcrt.locking (advisory OS-level locks that
 * release automatically on process exit, including a crash) -- it only
 * guards concurrent *Node-side* writers within this runner, not
 * simultaneous access from a Python process and a Node process at once.
 * That's an acceptable scope for Phase 1 (a task is owned by one side at a
 * time -- see docs/app/CONTEXT.md's ownership model), but is a real,
 * disclosed limitation, not full cross-process parity. */
export async function lockedReadModifyWrite<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + STALE_LOCK_MS * 4; // overall give-up ceiling, well past one staleness window
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await clearIfStale(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock: ${lockPath}`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

async function clearIfStale(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // already gone -- another writer's finally{} beat us to it
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write `data` as JSON to `path` atomically (write to a temp file, then
 * rename). Does not itself lock -- call from inside
 * lockedReadModifyWrite() when concurrent writers are possible. Ported
 * from crewbench_fs.py's atomic_write_json(). */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path.replace(/(\.[^./\\]+)?$/, ".tmp");
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

export async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

const EVENTS_FORMAT_VERSION = 1;

async function lastSeq(eventsPath: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(eventsPath, "utf-8");
  } catch {
    return 0;
  }
  let last = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { seq?: number };
      if (typeof parsed.seq === "number") last = parsed.seq;
    } catch {
      continue; // a torn/partial last line from a crash mid-write
    }
  }
  return last;
}

/** Append one line to <taskDir>/events.jsonl: `{ v, ts, seq, type,
 * task_id, run, data }`. Ported from crewbench_fs.py's append_event() --
 * see docs/app/contract/events.md for the full event catalog. Locks +
 * reads the last seq under one critical section, so concurrent Node-side
 * writers never interleave partial lines or duplicate seq (see
 * lockedReadModifyWrite()'s docstring for this module's locking scope). */
export async function appendEvent(
  taskDir: string,
  type: string,
  data: Record<string, unknown>,
  run: string | null = null,
): Promise<Record<string, unknown>> {
  const eventsPath = join(taskDir, "events.jsonl");
  const lockPath = join(taskDir, ".events.lock");
  return lockedReadModifyWrite(lockPath, async () => {
    const seq = (await lastSeq(eventsPath)) + 1;
    const event = {
      v: EVENTS_FORMAT_VERSION,
      ts: nowIso(),
      seq,
      type,
      task_id: taskDirName(taskDir),
      run,
      data,
    };
    await mkdir(dirname(eventsPath), { recursive: true });
    const handle = await open(eventsPath, "a");
    try {
      await handle.appendFile(JSON.stringify(event) + "\n", "utf-8");
    } finally {
      await handle.close();
    }
    return event;
  });
}

function taskDirName(taskDir: string): string {
  const normalized = taskDir.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] ?? normalized;
}
