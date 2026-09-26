import { chmodSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty is a true optional dependency (package.json's own
// optionalDependencies) -- a dynamic, wrapped require via createRequire
// (this module is ESM, `type: "module"`) so a platform where it never
// installed at all doesn't fail to even load this module, only this
// function's own try/catch below.
const require = createRequire(import.meta.url);

/** A minimal shape of the real `node-pty` module (just what this daemon
 * actually calls), used instead of `typeof import("node-pty")` so this
 * file typechecks whether or not `node-pty` is genuinely installed --
 * it's a true optional dependency (per Design decision 3), and this
 * module's own job is detecting its absence gracefully, not assuming
 * its types are always resolvable. */
export interface PtyLikeProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export interface PtyModule {
  spawn(file: string, args: string[] | string, opts: Record<string, unknown>): PtyLikeProcess;
}

/** Whether this daemon process can genuinely open an embedded terminal
 * (Phase 4 milestone 3, Design decision 3) -- `node-pty` is a true
 * `optionalDependencies` entry (a native module; it can fail to build on
 * some platforms and must never break install or `require()` of the
 * daemon itself when it does). Computed once, at daemon startup, and
 * cached for the process's lifetime -- spawning a real pty on every
 * capability check would be wasteful, and this can't meaningfully change
 * mid-process.
 *
 * **A real, disclosed gap found live investigating this**: `require("node-pty")`
 * succeeding is NOT sufficient proof that spawning actually works. On
 * this machine (macOS/arm64), a real `pnpm install`/`npm install` of
 * `node-pty@1.1.0` leaves its prebuilt native `spawn-helper` binary
 * *not executable* (`-rw-r--r--`) -- confirmed with a real plain `npm
 * install node-pty` into a scratch directory outside this monorepo too,
 * so this is a real node-pty packaging characteristic, not a pnpm-
 * specific config gap. (An earlier version of this investigation
 * incorrectly assumed node-pty's own `postinstall` -- `scripts/post-
 * install.js` -- handled this; reading that script directly shows it
 * only ever touches a node-gyp `build/Release` folder and, on Windows,
 * `conpty.dll` -- it never touches the `prebuilds/<platform>/spawn-helper`
 * file this package's *actual* runtime path resolves to when a prebuild
 * is used, which is the normal case.) Without a fix, `pty.spawn()`
 * throws `Error: posix_spawnp failed` the first time anything actually
 * tries to open a session -- a real user-facing failure this capability
 * check must not silently miss by trusting `require()` alone.
 *
 * Fixed here defensively, not by relying on the install step to have
 * done it: after a successful `require()`, `chmod +x` every
 * `prebuilds/*\/spawn-helper` file found under node-pty's own package
 * directory (a no-op, harmless glob on Windows, where node-pty uses
 * `conpty.node` instead and ships no `spawn-helper` at all), then prove
 * the fix actually worked with a real, cheap spawn -- a trivial `exit 0`
 * (`cmd.exe /c exit 0` on Windows) inside this function itself, not
 * assumed successful just because the chmod didn't throw. */
export interface PtyCapability {
  available: boolean;
  reason: string | null;
}

function tryChmodSpawnHelpers(pkgDir: string): void {
  // Best-effort only: a read-only filesystem, an unexpected prebuilds
  // layout, or Windows (no spawn-helper file at all) are all real,
  // non-fatal cases -- swallowed here since the real proof of success
  // is the actual test-spawn this function's caller does next, not this
  // step succeeding in isolation.
  try {
    const prebuildsDir = join(pkgDir, "prebuilds");
    for (const platformDir of readdirSync(prebuildsDir)) {
      const helper = join(prebuildsDir, platformDir, "spawn-helper");
      try {
        const st = statSync(helper);
        if (st.isFile()) chmodSync(helper, 0o755);
      } catch {
        // no spawn-helper for this platform dir (e.g. win32) -- fine
      }
    }
  } catch {
    // no prebuilds/ dir at all (e.g. a from-source node-gyp build) -- fine
  }
}

/** Loads the real `node-pty` module for an actual session
 * (`pty-session.ts`) -- only ever called after `detectPtyCapability()`
 * has already reported `available: true`, so this is expected to
 * succeed; throws otherwise (a caller that skipped the capability check
 * is a real bug, not something to paper over here). */
export function loadPty(): PtyModule {
  return require("node-pty") as PtyModule;
}

let cached: PtyCapability | null = null;

export function detectPtyCapability(): PtyCapability {
  if (cached) return cached;
  cached = computePtyCapability();
  return cached;
}

/** Exposed for tests only, so a real (not just cached-once) detection
 * can be exercised against a fresh state. */
export function computePtyCapability(): PtyCapability {
  let pty: PtyModule;
  let pkgDir: string;
  try {
    // Dynamic require, not a static import: node-pty is optional, and a
    // static import would make the whole daemon module fail to load on
    // a platform where it genuinely isn't installed (this package.json's
    // own optionalDependencies entry can legitimately be absent).
    const resolved = require.resolve("node-pty");
    pkgDir = dirname(dirname(resolved)); // .../node-pty/lib/index.js -> .../node-pty
    pty = require("node-pty") as PtyModule;
  } catch (err) {
    return { available: false, reason: `node-pty not installed: ${err instanceof Error ? err.message : String(err)}` };
  }

  tryChmodSpawnHelpers(pkgDir);

  try {
    const shell = process.platform === "win32" ? "cmd.exe" : "sh";
    const args = process.platform === "win32" ? ["/c", "exit", "0"] : ["-c", "exit 0"];
    const p = pty.spawn(shell, args, { name: "xterm-color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
    // node-pty's own spawn() is synchronous (the exception, if any,
    // throws before this line) -- the child having been created at all
    // is the actual proof `posix_spawnp`/CreateProcess succeeded. Kill
    // it immediately; this is a capability probe, not a session anyone
    // will use.
    p.kill();
    return { available: true, reason: null };
  } catch (err) {
    return { available: false, reason: `node-pty loaded but a real test spawn failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
