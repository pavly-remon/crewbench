#!/usr/bin/env node
// Phase 4 milestone 1: builds the actual publishable `crewbench` npm
// package into packages/cli/publish/ -- a directory separate from
// packages/cli/dist/ (the existing plain `tsc -b` output every dev/test
// workflow already depends on, and this script never touches).
//
// Real, disclosed deviation from the plan's literal "remove private:true
// from packages/cli/package.json, add a files field" wording: that
// package.json's own `dependencies` are workspace:* references to the
// four internal packages (adapters/contract/daemon/engine) -- required
// for pnpm's dev-time module resolution and this package's own `tsc -b`
// build to work at all, and NOT something this milestone can remove
// without breaking local dev. But `workspace:*` is a pnpm-only protocol;
// `npm install crewbench` against a published package.json still
// carrying it would fail outright (npm has no registry range called
// "workspace:*"). Since Design decision 1 bundles those four packages'
// code directly into one file rather than publishing them, the published
// package.json must not reference them as dependencies at all. Resolved
// by generating a separate, minimal package.json here, inside
// publish/ -- the actual artifact `npm publish`/`npm pack` run against --
// rather than force packages/cli/package.json to serve two incompatible
// purposes (pnpm workspace member and standalone npm package) at once.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, ".."); // packages/cli
const appRoot = join(cliRoot, "..", ".."); // app/
const repoRoot = join(appRoot, ".."); // repo root (agents/, schemas/, config/)
const outDir = join(cliRoot, "publish");

// Real npm dependencies the bundle needs at runtime (confirmed by
// grepping every package's actual `from "<pkg>"` imports, not assumed --
// zod, fastify, @fastify/static, chokidar, @fastify/websocket (Phase 4
// milestone 3 -- the embedded terminal's own WebSocket channel);
// everything else imported across contract/adapters/engine/daemon/cli is
// either a workspace package (inlined below by esbuild) or a node:
// builtin). Versions read from each package's own package.json, not
// hand-typed, so this can't silently drift from what's actually
// installed. Kept external (not esbuild-inlined) for the same reason as
// milestone 1's own original four: avoids duplicating a real npm
// package's worth of code into this one file for no reason -- caught
// live this milestone (build-publish's very first re-run after adding
// @fastify/websocket to the daemon jumped bin.js from ~212KB to ~465KB
// because it wasn't in this list yet and got bundled in whole).
const EXTERNAL_DEPS = ["zod", "fastify", "@fastify/static", "@fastify/websocket", "chokidar"];

// node-pty (Phase 4 milestone 3) is a *native* module -- it ships a real
// compiled `.node` binary plus a `spawn-helper` executable it locates
// relative to its own package directory at runtime (`pty-capability.ts`'s
// own docstring has the full story on why that directory's exec bit
// needs defensive fixing up too). esbuild already leaves it alone as-is
// (confirmed by reading the actual bundled bin.js: `require("node-pty")`
// stays a real, dynamic runtime call, since `pty-capability.ts` calls it
// through a `createRequire()`-bound variable, not a literal `require(...)`
// esbuild would try to statically resolve and inline) -- but a *real,
// separate* gap this milestone's own live pack+install check caught: the
// generated package.json below never listed node-pty as a dependency of
// any kind, so a real `npm install crewbench` would never even attempt
// to install it, permanently disabling the embedded terminal for every
// real user regardless of platform. Listed here, separately from
// EXTERNAL_DEPS, since it belongs in `optionalDependencies`, not
// `dependencies` -- a failed install must never fail the whole package
// install (Design decision 3's own "must never break install... when it
// does" requirement).
const OPTIONAL_EXTERNAL_DEPS = ["node-pty"];

async function resolveDepVersion(name, { optional = false } = {}) {
  for (const pkg of ["daemon", "engine", "contract", "adapters", "cli"]) {
    const pkgJsonPath = join(appRoot, "packages", pkg, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
    const version = optional ? pkgJson.optionalDependencies?.[name] : pkgJson.dependencies?.[name];
    if (version) return version;
  }
  throw new Error(`could not find a declared ${optional ? "optional " : ""}version for ${name} in any workspace package.json`);
}

async function main() {
  console.log(`[build-publish] cleaning ${outDir}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const uiDist = join(appRoot, "packages", "ui", "dist");
  if (!existsSync(join(uiDist, "index.html"))) {
    throw new Error(
      `UI isn't built yet (expected ${join(uiDist, "index.html")}) -- run ` +
        `\`pnpm --filter @crewbench/ui build\` before build:publish.`,
    );
  }

  console.log("[build-publish] bundling packages/cli/src/bin.ts with esbuild");
  const result = await build({
    entryPoints: [join(cliRoot, "src", "bin.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: join(outDir, "bin.js"),
    // Internal @crewbench/* packages are workspace:*-only, never
    // published -- esbuild inlines their real source (via pnpm's own
    // node_modules symlinks, the same resolution `tsc -b` already uses
    // for dev) directly into this one file. Only genuine third-party npm
    // packages are left external, resolved normally by npm at install
    // time instead of being bundled in (avoids duplicating a full web
    // framework's worth of code into this file for no reason).
    // OPTIONAL_EXTERNAL_DEPS (node-pty) also passed here, explicitly --
    // esbuild already leaves it alone as a dynamic `require()` (see that
    // list's own docstring), but marking it external too is cheap,
    // correct, and removes any doubt for a future esbuild version that
    // might analyze dynamic requires more aggressively.
    external: [...EXTERNAL_DEPS, ...OPTIONAL_EXTERNAL_DEPS],
    // No explicit banner: esbuild already recognizes and preserves a
    // `#!`-shebang line on the entry file itself (bin.ts has one) --
    // adding one here too duplicated it, caught live by actually reading
    // the built output, not assumed correct.
    logLevel: "info",
    metafile: true,
  });
  const bytes = Buffer.byteLength((await readFile(join(outDir, "bin.js"))).toString(), "utf-8");
  console.log(`[build-publish] bin.js: ${(bytes / 1024).toFixed(0)} KB`);
  if (result.warnings.length > 0) {
    console.warn(`[build-publish] ${result.warnings.length} esbuild warning(s) -- see above`);
  }

  console.log("[build-publish] copying UI dist -> publish/ui-dist");
  await cp(uiDist, join(outDir, "ui-dist"), { recursive: true });

  // findRoot() (packages/cli/src/root.ts) walks UP from its own bundled
  // file's location looking for a directory containing both agents/ and
  // schemas/ as direct children -- copying them here, as direct siblings
  // of bin.js, makes that existing walk-up logic find them immediately
  // (i=0 in its own loop) with zero code changes to root.ts itself.
  // config/ (defaultsPath()) rides along the same way. Same reasoning
  // covers static-ui.ts's own packaged-layout branch (see that file's
  // own updated docstring).
  for (const name of ["agents", "schemas", "config"]) {
    const src = join(repoRoot, name);
    if (!existsSync(src)) throw new Error(`missing ${src} -- can't build a working publish bundle without it`);
    console.log(`[build-publish] copying ${name}/ -> publish/${name}`);
    await cp(src, join(outDir, name), { recursive: true });
  }

  const cliPkgJson = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf-8"));
  const dependencies = {};
  for (const dep of EXTERNAL_DEPS) {
    dependencies[dep] = await resolveDepVersion(dep);
  }
  const optionalDependencies = {};
  for (const dep of OPTIONAL_EXTERNAL_DEPS) {
    optionalDependencies[dep] = await resolveDepVersion(dep, { optional: true });
  }

  const publishPkgJson = {
    name: cliPkgJson.name,
    version: cliPkgJson.version,
    description: "Run the crewbench multi-agent dev workflow headlessly, or start its local web UI.",
    type: "module",
    // No leading "./" -- npm's own publish validation silently rewrites
    // "./bin.js" to "bin.js" (a real `npm publish --dry-run` warning
    // caught this live: "bin[crewbench] script name bin.js was invalid
    // and removed"), so the checked-in generator matches what npm
    // actually wants rather than relying on that auto-fix.
    bin: { crewbench: "bin.js" },
    main: "./bin.js",
    engines: { node: ">=20" },
    dependencies,
    optionalDependencies,
    files: ["bin.js", "ui-dist", "agents", "schemas", "config"],
    repository: cliPkgJson.repository,
    license: cliPkgJson.license,
  };
  // Drop undefined optional fields (repository/license) rather than
  // publish literal "undefined" -- neither is set on the source
  // package.json today (Open question about repo metadata is separate
  // from this milestone's own scope).
  for (const key of Object.keys(publishPkgJson)) {
    if (publishPkgJson[key] === undefined) delete publishPkgJson[key];
  }
  await writeFile(join(outDir, "package.json"), JSON.stringify(publishPkgJson, null, 2) + "\n", "utf-8");
  console.log(
    `[build-publish] wrote publish/package.json (${Object.keys(dependencies).length} real npm dependencies, ` +
      `${Object.keys(optionalDependencies).length} optional)`,
  );

  console.log(`[build-publish] done -- publish bundle ready at ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
