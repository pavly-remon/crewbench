import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "@crewbench/engine";
import type { ApiUpdateCheckResponse } from "@crewbench/contract";

/** Where this daemon process's own `package.json` lives, resolved for
 * either real layout it can run from -- the same dual-branch pattern
 * `static-ui.ts`'s `defaultUiDist()` already established (Phase 4
 * milestone 1):
 *
 * 1. **The published/bundled `crewbench` package**: esbuild inlines this
 *    module into `publish/bin.js`, and `build-publish.mjs` writes a real
 *    `publish/package.json` right next to it with the actual published
 *    version -- the meaningful case this feature exists for.
 * 2. **This repo's monorepo dev layout**: this file compiles to
 *    `packages/daemon/dist/update-check.js`; `packages/cli/package.json`
 *    (the package that would actually get published) is two directories
 *    over, not the same directory as `packages/daemon/package.json`'s
 *    own, separate `0.1.0` -- reading the *cli* package's version here,
 *    not the daemon package's own, since that's the real "current
 *    version" this feature means (what a `npm i -g crewbench` user has).
 *
 * `current: null` (not a thrown error) when neither resolves -- a
 * genuinely unbundled dev checkout with no reachable `cli/package.json`
 * (e.g. this package imported standalone in a test) is a real, expected
 * case, not a bug to crash over. */
function currentVersion(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "package.json"), join(here, "..", "..", "cli", "package.json")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "crewbench" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // malformed/foreign package.json at this candidate path -- try the next one
    }
  }
  return null;
}

/** Simple `MAJOR.MINOR.PATCH` numeric comparison -- `scripts/bump_version.py`'s
 * own `VERSION_RE` already enforces this shape repo-wide, so a real
 * semver library (range parsing, prereleases, build metadata) is more
 * than this actually needs; not added per `docs/app/CONTEXT.md`'s "don't
 * add dependencies beyond the stack without a reason." Returns `false`
 * (never "update available") for anything that doesn't parse as three
 * numbers, rather than guessing. */
function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // "at most once a day," per the phase prompt's own wording

let cached: ApiUpdateCheckResponse | null = null;
let cachedAt = 0;

/** `GET https://registry.npmjs.org/crewbench/latest` (Design decision 7)
 * -- a real registry call, cached for `CACHE_TTL_MS` in this module's own
 * closure (module-level, not per-daemon-instance like `doctor.ts`'s own
 * cache: unlike a doctor check, an update check has no per-project or
 * per-request-context meaning, and this repo's test suite starting many
 * daemon instances in one process should share one real cache rather
 * than each re-hitting the real npm registry). Never throws -- a network
 * failure or an unparseable response reports `error`, not a crash; this
 * is a non-blocking UI banner, never something that should affect
 * startup or any other daemon behavior. */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<ApiUpdateCheckResponse> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  const current = currentVersion();
  let latest: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetchImpl("https://registry.npmjs.org/crewbench/latest", { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      latest = typeof body.version === "string" ? body.version : null;
      if (!latest) error = "registry response had no version field";
    } else {
      error = `registry returned ${res.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const result: ApiUpdateCheckResponse = {
    current,
    latest,
    update_available: current !== null && latest !== null && isNewer(latest, current),
    error,
    checked_at: nowIso(),
  };
  cached = result;
  cachedAt = Date.now();
  return result;
}

/** Exposed for tests only, so a fresh check (not the cached-for-a-day
 * value) can be exercised. */
export function resetUpdateCheckCache(): void {
  cached = null;
  cachedAt = 0;
}
