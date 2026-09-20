# Phase 4 — Packaging, install, multi-project polish

Status: **in progress** (reviewed and approved 2026-09-20: design
decisions 1-9 and open questions 1-4 confirmed with the recommended
approach — bundle-and-publish-one-package via esbuild, background
service in scope for this phase's first pass, embedded terminal in
scope with graceful node-pty fallback, `/crewbench:open` ships the
tokenless-URL approach, keeping Phase 2's "never persisted" token
principle unchanged. Open question 5 — confirming "crewbench" as the
actual package name — stays open until immediately before the real,
non-dry-run publish step in milestone 1, since availability is a
point-in-time fact, not a reservation. Milestone 1 implemented
2026-09-20, pending human review -- see its log entry.)

Read first: `docs/app/CONTEXT.md`, `docs/app/build-prompts.md`'s Phase 4
section (the literal phase prompt this plan is based on), and
`docs/app/phase-3-plan.md`'s milestone logs (what actually shipped,
including deviations) — this phase packages what Phase 3 built, so its
real shape (what's daemon-hosted vs. CLI-headless, what owner/active
mean, what doesn't exist yet like worktree isolation for app-owned
tasks) matters more here than the phase prompt's own abstract wording.

## Goal (unchanged from the phase prompt)

Anyone on macOS, Linux or Windows can install crewbench with one command
and have it running in under two minutes. The UI can also open real
agent sessions in an embedded terminal.

## Findings from reading the current code, not assumed

These change what several of the phase prompt's own scope items
concretely require, so they're called out before the design decisions
that follow from them.

1. **Publishing is entirely unconfigured today, and the workspace's own
   dependency style doesn't survive a plain `npm install` of a published
   package.** `app/packages/cli/package.json`: `"private": true`, no
   `files` field (so nothing scopes what actually ships), and its four
   dependencies are all `"workspace:*"` —
   `@crewbench/{adapters,contract,daemon,engine}`. That protocol is
   resolved by pnpm's own workspace linking at dev time; a plain
   `npm i -g crewbench` against a published tarball has no workspace to
   resolve it against at all. Either all five packages get published to
   npm with real semver (and `workspace:*` gets rewritten at publish
   time — `pnpm publish` does this automatically, confirmed by reading
   pnpm's own publish behavior, not the npm CLI's), or the four internal
   packages get bundled into the `cli` package's own output so nothing
   external is required. No bundler (esbuild, rollup, tsup, etc.) is a
   dependency anywhere in `app/` today — `docs/app/CONTEXT.md`'s stack
   list doesn't name one either. This is the single largest technical
   fork in this phase; see Design decision 1 and Open question 1.
2. **The package name `crewbench` is available on npm.** Checked
   directly against the registry API (`https://registry.npmjs.org/crewbench`
   returns a real `404 Not Found`, not a fetch failure), not assumed.
   Confirming with the user before the actual publish step anyway (Open
   question 5) — losing a squatted name is unrecoverable, and this
   finding is a point-in-time check, not a reservation.
3. **The UI's static-file serving already knows its own path resolution
   won't survive packaging, and says so.** `packages/daemon/src/static-ui.ts`'s
   `defaultUiDist()` resolves the built UI at `../../ui/dist` relative to
   its own file — correct for the monorepo dev layout
   (`packages/daemon/src` and `packages/ui/dist` are siblings under
   `packages/`), but its own comment already flags: *"Phase 4's packaged
   npm install will need its own resolution strategy... out of scope
   here."* If Design decision 1 goes the bundling route, this path
   resolution breaks outright (there's no longer a `packages/ui/`
   sibling once the daemon's own source is bundled into one file) and
   needs a real fix, not just a new default value — see Design
   decision 1.
4. **`~/.crewbench/config.json` today only has `port` and
   `concurrency`.** Confirmed directly (`packages/contract/src/schemas/registry.ts`'s
   `DaemonConfigSchema`) — `default lineup`, `notification preferences`,
   and `theme` (scope item 5's own list) are real, net-new additive
   fields, not already-present-but-unwired ones (unlike several fields
   earlier phases found already anticipated and just needing to be
   wired up).
5. **No daemon-instance singleton, and no locking on `registry.json`
   writes.** `packages/daemon/src/port.ts`'s `findOpenPort()` just walks
   forward from the preferred port until one is free — running
   `crewbench ui` twice on one machine today starts two fully
   independent daemon processes, each with its own in-memory token, both
   reading and writing the *same* `~/.crewbench/projects.json`.
   `registry.ts`'s `saveRegistry()` is a plain read-then-`atomicWriteJson`
   with no lock file spanning the read-modify-write — the identical
   class of bug Phase 0 fixed for `state.json`/`index.json` on the
   Python side (`crewbench_fs.py`'s `locked_read_modify_write`), just
   never ported to this file. Today this is a rare, manually-triggered
   race (who runs `crewbench ui` twice on purpose); once Phase 4's
   background service can keep one daemon running silently at login,
   "user later also runs `crewbench ui` by hand" becomes the *normal*
   way to hit it. See Design decision 4.
6. **Onboarding has real infrastructure to reuse, not build from
   scratch.** `ProjectsPage` already has a real empty state ("No
   projects registered yet...") and an Add-project dialog (Phase 3,
   extended this session with a server-side folder browser instead of
   free-text path entry); `GET /api/doctor` and the existing Health page
   (Phase 2) already report per-CLI installed/logged-in/error state.
   There is no first-run *wizard* (a guided, ordered flow across these)
   today — that part is genuinely new.
7. **Embedded terminal: nothing exists yet, and the command it would run
   already exists but has a real, unguarded conflict hazard.**
   `node-pty`/`xterm.js` appear nowhere in any `package.json` today —
   confirmed by grep, not assumed missing. `packages/ui/src/components/task-controls.tsx`'s
   `CopyResumeCommand` already builds the exact string the phase prompt
   means by "that run's resume_command" — `crewbench resume <task-id>`,
   run from the project root (Phase 3's own finding still holds: an
   app-owned task has no worktree at all today, so "in the task's
   worktree" doesn't apply — it runs in the project root, same as
   `TaskRunner` itself does). **Real hazard**: `packages/cli/src/commands/resume.ts`
   never checks `owner` or whether a daemon is already actively driving
   this task in-process — running `crewbench resume <id>` from a
   terminal against a task the daemon's own `TaskRunner` currently has
   active would start a second, concurrent `driveTask()` loop over the
   same `taskDir`, racing dispatches and file writes. `task-controls.tsx`
   already has the right guard for the in-app Resume button
   (`canResume = !detail.active && ...`) — an embedded terminal's "Open
   session" button needs the identical guard, not a new one. Today the
   copy-to-clipboard button has *no* such guard at all (a real,
   pre-existing Phase 3 gap, out of that phase's own scope but relevant
   here since Phase 4 makes the same unguarded action one click away
   instead of copy-paste-away).
8. **Background service: no launchd/systemd/Task Scheduler code exists
   anywhere in this repo** — confirmed by grep, genuinely new ground,
   and directly dependent on finding 5 above being fixed first (a
   service that starts a daemon at login, with no singleton check and no
   registry locking, is the exact scenario finding 5 describes as
   "the normal way to hit it").
9. **The plugin↔app bridge's real blocker is a deliberate security
   decision, not a missing feature.** `skills/status/SKILL.md` today is
   entirely Python-side and read-only — no mention of `crewbench ui`
   anywhere, a genuinely new addition, not a wire-up. But the harder
   half of scope item 6, a `/crewbench:open [task-id]` skill, needs to
   discover a *running* daemon's port and bearer token — and
   `packages/daemon/src/auth.ts`'s own docstring states this token is
   "never persisted" **on purpose** (a real Phase 2 security decision:
   loopback-only binding plus a process-lifetime-only token, so nothing
   on disk can leak API access to this daemon). There is no file
   anywhere today a skill could read a live token from. Scope item 6 as
   literally worded ("opens the task in the UI") is in real tension with
   that principle — resolving it needs an explicit decision, not a
   silent workaround. See Design decision 6 and Open question 2.
10. **`bump_version.py` only knows about the three plugin manifests.**
    Read directly (`scripts/bump_version.py`): it bumps
    `plugin.json`/`.claude-plugin/plugin.json`/`.codex-plugin/plugin.json`
    and nothing else — it has no awareness of `app/packages/*/package.json`
    at all. Scope item 8's "extend bump_version.py" is real, scoped work,
    not a doc update. Separately: `CHANGELOG.md` has exactly one entry
    since this app build started (`v3.1.0`, Phase 0) — phases 1, 2, and 3
    were never given their own entries. Not this phase's fault to fix
    retroactively, but the first real app release's own CHANGELOG entry
    (this phase's own deliverable) will need to account for everything
    since v3.1.0, not just this phase's own diff, or it'll read as if
    the app didn't exist before Phase 4.
11. **CI already has a real 3-OS matrix to extend, not a reason to build
    one from scratch.** `.github/workflows/ci-node.yml` already runs
    build/test/typecheck on `ubuntu-latest`/`macos-latest`/`windows-latest`
    for every push/PR touching `app/**`. The release workflow (scope
    item 8) should extend this existing matrix with a tag-gated publish
    job, not stand up a second, parallel one.
12. **README.md today is 445 lines, entirely plugin-focused — zero
    mention of the app, UI, daemon, or CLI.** Confirmed by reading it in
    full. Scope item 9's rewrite is a real, substantial addition, not a
    light edit.

## Design decisions

1. **Publishing: bundle, don't multi-publish — a new dependency
   (esbuild), disclosed per the working agreement.** Publishing five
   separately-versioned `@crewbench/*` packages (contract, adapters,
   engine, daemon, cli) in the right dependency order on every release
   is real, ongoing operational complexity this phase doesn't need to
   take on for a first packaged release. Proposing: `esbuild` bundles
   `packages/cli`'s entry point (and everything it imports from the
   other four workspace packages) into a single output file inside
   `packages/cli/dist/`, published as the sole `crewbench` npm package —
   the other four packages stay `"private": true`, never published.
   `esbuild` is not in `docs/app/CONTEXT.md`'s stack list — flagging
   this explicitly as a new dependency, scoped to a build-time devDependency
   of `packages/cli` only, with the reason above. **Open question 1**
   asks the user to confirm this over the multi-publish alternative
   before milestone 1 starts, since reversing it later means redoing the
   whole publish pipeline.
2. **UI dist resolution: ship the built UI inside the published tarball
   at a package-root-relative path, not a source-file-relative one.**
   `static-ui.ts`'s `defaultUiDist()` gets a real second branch: resolve
   the UI's dist directory relative to the *package root* (found via
   `import.meta.resolve` or reading the nearest `package.json`, not
   `../../ui/dist` from the bundled file's own location, which won't
   exist post-bundling) — `packages/ui/dist`'s contents get copied into
   `packages/cli/dist/ui/` (or similar) as part of the `cli` package's
   own build step, and `package.json`'s `files` field includes it
   explicitly. `CREWBENCH_UI_DIST` keeps working unchanged for local dev
   and tests (already an env override, untouched). A real, disclosed
   edit to already-shipped Phase 2 code, per the same working-agreement
   norm every earlier phase's plan has followed.
3. **Onboarding: a new first-run wizard route that layers on existing
   infrastructure, not a replacement for it.** Reuses `GET /api/doctor`
   and the existing per-CLI report shape (Phase 2) for "detect which of
   the 4 CLIs are installed and logged in," and the existing Add-project
   dialog (Phase 3, this session's folder-browser update included) for
   "add the first project" — the wizard's job is *sequencing* these
   (and the new "offer to install the plugin" step, genuinely new) into
   one guided flow shown only when `GET /api/projects` returns empty,
   not rebuilding any of them.
4. **Background service is real, and ships with its own prerequisite
   fix, not just the service-install commands.** Before a
   `crewbench service install` command exists, `registry.ts`'s
   `saveRegistry()` gets the same locked-read-modify-write treatment
   `crewbench_fs.py` already gives `state.json`/`index.json` on the
   Python side (finding 5) — a new `lockedReadModifyWrite`-equivalent in
   the TS registry code, ported in spirit, not copied verbatim (different
   language, same real bug class). Additionally, `findOpenPort()` (or a
   new startup check ahead of it) refuses to start a second daemon when
   a live one is already reachable at the configured port — printing
   that daemon's own URL and exiting cleanly instead of silently opening
   a second, independent instance. This turns "two daemons fighting over
   one registry file" from a live risk into a refused-at-startup
   condition. Scoped as launchd (macOS) / a systemd user unit (Linux) /
   Windows Task Scheduler, matching the phase prompt's own three
   targets — each genuinely needs testing on its real OS, not assumed
   symmetric.
5. **Settings: three new additive `config.json` fields plus a real
   global settings page.** `default_lineup` (same shape as `team.json`'s
   own `roles`, reusing `TeamSchema`'s `RoleLineupSchema` rather than a
   parallel type), `notifications` (mirrors the existing client-side-only
   opt-in flag Phase 3 milestone 5 already built, persisted here as the
   default instead of only `localStorage`), and `theme`. New
   `GET/PUT /api/config` daemon route, same envelope/validation pattern
   Phase 3's team/profile routes established. New UI settings route,
   linked from the app shell (`components/layout.tsx`, which Phase 3
   milestone 4 already extended once for the approvals inbox).
6. **Plugin↔app bridge: `/crewbench:open` opens a bare, tokenless URL by
   default — a new discovery file is a separate, explicitly-confirmed
   decision, not bundled in silently.** Proposing the skill prints/opens
   `http://127.0.0.1:<port>/projects/<id>/tasks/<task-id>` (or just the
   base URL if the daemon isn't running, with instructions to start it)
   with **no token in it** — the person still authenticates through
   whatever browser session already holds the token from when they ran
   `crewbench ui` themselves (the token lives in `location.hash`, which
   a same-origin browser tab already navigated to still has). This
   preserves Phase 2's "never persisted" principle exactly, at the cost
   of the skill not being able to deep-link a *fresh* tab straight past
   auth if none is open yet. **Open question 2** asks whether that
   tradeoff is acceptable, or whether the user wants a real (and
   explicitly reviewed) discovery mechanism instead — e.g. a
   restrictive-permissions, daemon-lifetime-only file under
   `daemonHome()` — before any code implements one.
7. **Updates: reuse the same registry-API check Open question 5's own
   name-availability check used, cached like `doctor.ts`.** `GET
   https://registry.npmjs.org/crewbench/latest` (or the `dist-tags`
   shape), polled at most once/day, cached in the daemon's own memory
   (`doctor.ts`'s existing `CACHE_TTL_MS` pattern, just a much longer
   TTL) — a non-blocking UI banner only, never auto-updating, exactly as
   the phase prompt words it.
8. **Release pipeline: extend, not duplicate.** `bump_version.py` gains
   a second manifest list (`app/packages/cli/package.json`, plus the
   other four if Design decision 1's bundling call changes and they
   become independently versioned too) bumped alongside the existing
   three plugin manifests, one shared version number
   (`docs/app/CONTEXT.md`'s own non-negotiable-adjacent goal, matching
   how the plugin's own three manifests already share one version
   today). `ci-node.yml`'s existing 3-OS matrix gains a `publish` job
   gated on a version tag push, running after the existing
   build/test/typecheck steps pass on all three OSes (the actual
   Definition-of-Done claim), not a new parallel workflow file.
9. **Docs: full README rewrite, scoped as this phase's own milestone 5
   sub-item**, covering both plugin and app install paths, a quick
   start, and a troubleshooting section built from real `doctor()`
   failure modes (`packages/adapters/src/doctor.ts`'s actual per-CLI
   error strings, not invented ones) — unchanged from the phase prompt's
   own wording, no real deviation found here.

## Milestones

Mapped 1:1 to the phase prompt's own list — nothing in the findings
above suggested a different split (unlike Phase 3, which found real
reasons to reshape its own numbering) — each ending in its own
commit(s), passing tests, and a note appended below once work starts.

### 1. Build/bundle + npm publish dry run + install tests in clean CI containers on 3 OSes

- `esbuild` added as a `packages/cli`-scoped devDependency (Design
  decision 1); a bundle build step producing `packages/cli/dist/bin.js`
  as a single file (or a small number of files if code-splitting the
  UI's own static assets out makes sense — TBD at milestone start, not
  pre-decided here).
- `static-ui.ts`'s package-root-relative resolution (Design decision 2).
- `package.json`'s `files`/`bin`/`main` fields for a real, minimal
  publish surface; `"private": true` removed.
- `npm publish --dry-run` (never a real publish this milestone) verified
  in CI, plus a real `npm pack` + `npm install <tarball>` +
  `crewbench doctor` smoke test in a clean container per OS (extending
  `ci-node.yml`'s existing matrix, per finding 11).

### 2. Onboarding flow + plugin install helper

- Daemon: whatever new endpoint(s) the "offer to install the plugin"
  step needs (likely just shelling out to the same install commands
  README.md already documents per-CLI, confirmed on-click, per the
  phase prompt's own "run it only on confirmation").
- UI: first-run wizard (Design decision 3).

### 3. Embedded terminal with fallback

- `node-pty` as a true optional dependency (`docs/app/CONTEXT.md`'s
  stack section already names this constraint) — a `package.json`
  `optionalDependencies` entry, with the daemon detecting at startup
  whether it loaded and exposing that as a capability flag the UI reads
  before showing "Open session" at all.
- UI: an xterm.js tab wired to the daemon's own PTY session (a new
  WebSocket or SSE-adjacent channel — TBD at milestone start), gated on
  `!detail.active` (finding 7's own conflict hazard) exactly like the
  existing Resume button's `canResume` condition, reusing it rather than
  re-deriving it.
- Fallback: `node-pty` unavailable → the existing "Copy resume command"
  button (already built, Phase 3 milestone 6) is what's shown instead of
  an "Open session" button, not a broken button.

### 4. Global settings + background service

- Daemon: `GET/PUT /api/config` (Design decision 5).
- `registry.ts`'s locked-read-modify-write fix and daemon-singleton
  startup check (Design decision 4) — real prerequisite work, done here
  since this is the milestone that first needs it to be safe.
- `crewbench service install|uninstall` for launchd/systemd
  user unit/Windows Task Scheduler.
- UI: global settings page.

### 5. Bridge skill + update banner + release workflow + docs

- `/crewbench:open [task-id]` skill (Design decision 6); `/crewbench:status`
  gains a "running in crewbench ui at <url>" mention when a live daemon
  is reachable (a plain, unauthenticated `GET /` liveness probe, not the
  token-gated API).
- Update banner (Design decision 7).
- Release workflow (Design decision 8) — including a real CHANGELOG
  entry covering everything since v3.1.0 (finding 10), not just this
  phase's own diff.
- README rewrite (Design decision 9).

## Files touched (new/changed, this phase)

New (exact paths TBD at each milestone, not pre-committed here):
`app/packages/cli/esbuild.config.*` or equivalent, `packages/daemon/src/pty-session.ts`
(embedded terminal), `packages/daemon/src/routes/config.ts`,
`packages/cli/src/commands/service.ts`, `packages/ui/src/routes/onboarding-wizard.tsx`
and friends, `packages/ui/src/routes/settings-page.tsx`,
`skills/open/SKILL.md`, `.github/workflows/ci-node.yml` (publish job
added, not a new file). Changed: `packages/daemon/src/static-ui.ts`
(Design decision 2), `packages/daemon/src/registry.ts` (locking, Design
decision 4), `packages/daemon/src/port.ts` (singleton check),
`packages/contract/src/schemas/registry.ts` (`config.json`'s three new
fields), `scripts/bump_version.py` (app package versions), `README.md`,
`CHANGELOG.md`, `skills/status/SKILL.md`.

## Open questions

Confirmed 2026-09-20 with the recommended approach for 1-4. Open
question 5 stays open by design (see its own entry).

1. **Bundle-and-publish-one-package vs. publish-all-five-with-real-versions**
   (Design decision 1, finding 1) — **confirmed: bundle via esbuild**,
   publishing only `crewbench`; the other four packages stay `private`.
2. **Whether `/crewbench:open`'s tokenless-URL approach (Design
   decision 6) is an acceptable tradeoff** — **confirmed: yes**, ships
   as designed. Phase 2's "never persisted" token principle stays
   unchanged; no new discovery file.
3. **Whether background-service installation (scope item 4) is in scope
   for this phase's first pass** — **confirmed: in scope**, with its
   prerequisite fix (Design decision 4's registry locking + daemon
   singleton check) done first, per the plan.
4. **Whether the embedded terminal (scope item 3) is worth its
   `node-pty` native-module cross-platform risk for a first packaged
   release** — **confirmed: in scope**, built as a true optional
   dependency with the existing "copy resume command" button as the
   real fallback when `node-pty` isn't available, per Design decision 3
   in the milestone log below.
5. **Confirming `crewbench` as the actual package name to publish**
   before milestone 1's real (non-dry-run) publish step — available as
   of this check (finding 2), but that's a point-in-time fact, not a
   reservation, and this is genuinely hard to undo once published.
   Deliberately left open until immediately before that real publish
   step, not resolved now.

## Milestone log

### Milestone 1 -- implemented, pending human review (2026-09-20)

**"crewbench" reconfirmed available on npm** immediately before this
work (`https://registry.npmjs.org/crewbench` still a real `404`, not
assumed carried over from the plan's own earlier check).

- **Built**: `packages/cli/scripts/build-publish.mjs`, a new script
  (`pnpm --filter crewbench build:publish` -- `packages/cli`'s own
  package name is the unscoped `"crewbench"`, not `@crewbench/cli`; see
  this log's own "real CI failure" entry below) that esbuild-bundles
  `packages/cli/src/bin.ts` -- inlining the real source of
  `@crewbench/{adapters,contract,daemon,engine}` (workspace packages,
  never published) while keeping genuine npm dependencies (`zod`,
  `fastify`, `@fastify/static`, `chokidar` -- confirmed the complete set
  by grepping every actual `from "<pkg>"` import across all five
  packages, not assumed) external -- into `packages/cli/publish/bin.js`,
  a single file. Copies `packages/ui/dist` to `publish/ui-dist` and the
  repo-root `agents/`/`schemas/`/`config/` directories to `publish/`
  alongside it. `static-ui.ts`'s `defaultUiDist()` gained a real second
  branch (Design decision 2, as planned): try the packaged `ui-dist`
  sibling first, fall back to the existing monorepo-relative path if it
  isn't there -- `CREWBENCH_UI_DIST` (what every existing test already
  sets explicitly) is untouched either way.
- **A real, disclosed deviation from the plan's literal wording**:
  the plan said "remove `private: true`, add a `files` field" to
  `packages/cli/package.json` directly. That file's own `dependencies`
  are `workspace:*` references pnpm needs for this package's ordinary
  `tsc -b` dev build and test suite to resolve at all -- removing them
  breaks local dev, keeping them makes the file unpublishable (`npm`
  has no registry range called `workspace:*`; a real `npm install` of a
  package.json still carrying one fails outright, confirmed by reading
  npm's own resolution behavior, not assumed). Resolved by generating a
  **separate, minimal `package.json` inside `publish/` itself** --
  `build-publish.mjs`'s own job, not a second copy of the source file --
  with only the four real npm dependencies (versions read live from each
  workspace package's own `package.json`, not hand-typed) and a `files`
  allowlist (`bin.js`, `ui-dist`, `agents`, `schemas`, `config`). The
  source `packages/cli/package.json` keeps `private: true` and its
  `workspace:*` deps completely unchanged -- it was never the thing this
  milestone actually publishes.
- **Two real bugs, caught live by actually reading and running the
  output, not assumed correct**:
  1. An explicit `banner: { js: "#!/usr/bin/env node" }` esbuild option
     duplicated the shebang -- `bin.ts`'s own source already has one,
     and esbuild already preserves an entry file's real shebang on its
     own. First build produced a real, broken double-shebang `bin.js`;
     caught by reading the first two lines of the actual output file
     before trusting it, not by assuming the option was needed. Fixed
     by removing the explicit banner entirely.
  2. `npm publish --dry-run`'s own real output flagged
     `"bin[crewbench]" script name bin.js was invalid and removed` --
     npm normalizes a `bin` path with a leading `./` by silently
     stripping it, and the generated `package.json` had `"./bin.js"`.
     Reproduced the exact fix with `npm pkg fix` against a scratch copy
     to confirm the real cause before changing anything, then fixed the
     generator itself to emit `"bin.js"` (no leading `./`) so nothing
     downstream needs npm's own auto-correction to produce a clean
     publish.
- **Real, live end-to-end verification, the actual milestone 1 claim,
  proven standalone -- not just that files exist**: `pnpm --filter
  @crewbench/ui build` + `build:publish`, then from `publish/`: `npm
  publish --dry-run` (clean, no warnings after the bin-path fix, 16
  files / 235.6 kB packed / 827.0 kB unpacked -- no source, no tests, no
  secrets in the tarball contents list); `npm pack` produced a real
  `crewbench-0.1.0.tgz`; installed with a plain `npm install
  <tarball>` into a fresh, empty directory *outside* the monorepo
  entirely (`/tmp/crewbench-install-test`, no relation to this repo's
  own `node_modules` or path structure); ran the real installed
  `./node_modules/.bin/crewbench` binary directly:
  - `--help` printed the real usage text.
  - `doctor` produced real, correct per-CLI reports for all four CLIs
    (this machine's own real claude/codex/agy/copilot installs, actually
    detected -- `findRoot()` genuinely resolved the bundled
    `agents/`+`schemas/` siblings from inside `node_modules/crewbench/`,
    with zero code changes to `root.ts` needed, exactly as Design
    decision 1's reasoning predicted).
  - `ui --port 41777 --no-open` started a real daemon; `curl`ing `/`
    returned the real bundled `index.html`, and a direct request for the
    real built JS asset filename (`assets/index-CiQ_4_QW.js`) returned
    200 with the correct byte size -- confirmed the installed
    package directory has no `ui-dist` fallback path to the monorepo at
    all (`ls node_modules/crewbench/` shows only `agents/ bin.js
    config/ package.json schemas/ ui-dist/`), so this wasn't reachable
    by accidental proximity.
  - `team show`, run from a fresh throwaway git repo, printed the real
    default lineup from the bundled `config/defaults.json`
    (`defaultsPath()`), confirming that resolution path too.
- **CI**: `.github/workflows/ci-node.yml` gained a new `package-smoke`
  job on the existing 3-OS matrix (not a new workflow file, per finding
  11) that runs the same sequence in CI: build, `build:publish`, `npm
  publish --dry-run` (never a real publish -- no step in this job omits
  `--dry-run`, and no registry credentials are referenced or needed),
  `npm pack`, install into `$RUNNER_TEMP` (outside the checkout
  entirely), then run the installed binary for real. `doctor`'s own exit
  code is deliberately not treated as pass/fail (none of the 4 real
  CLIs are installed on a GitHub-hosted runner, so `doctorCommand.ts`'s
  own `allOk` is genuinely false there by design) -- instead the step
  greps the real captured output for all four CLIs' own report lines, so
  a genuine crash or a missing-root error would still fail the job,
  while an expected "not installed" report doesn't. Not yet run for
  real in CI (this session has no way to trigger a GitHub Actions run) --
  flagged below as needing a real CI run, not just local verification,
  before this is trusted cross-platform.
- Full local verification: `pnpm -r typecheck/build/test` all green
  (412 TS tests, unchanged from before this milestone), both Playwright
  e2e tests still passing, Python suite (212 tests) unaffected. One
  `test/lineup.test.ts` flake under full parallel `pnpm -r test` load
  (a filesystem-watcher-debounce timeout, the same known flake class
  seen in earlier phases -- confirmed by rerunning that file alone,
  passed cleanly, not a real regression from this milestone's changes).
- Added `app/packages/cli/publish/` to `app/.gitignore` -- a real build
  output directory, same treatment as `dist/`, never meant to be
  committed.
- **What still needs human sign-off before this is "done"**: (1) a real
  GitHub Actions run of the new `package-smoke` job on all three OSes --
  this session verified the exact same sequence locally on macOS only,
  and Windows/Linux runner quirks (path separators, npm's bin-shim
  generation, `$RUNNER_TEMP` under `shell: bash`) are real, disclosed,
  unverified risk until a real CI run confirms them; (2) the
  generated-`publish/package.json` approach as the resolution to the
  plan's `workspace:*` conflict, a real deviation from the plan's
  literal wording, described above -- confirming this is the right
  shape before later milestones (e.g. the release workflow, milestone 5)
  build on top of it; (3) whether `packages/cli/publish/`'s exact
  directory name and structure is worth locking in now or still open to
  change before a real publish ever happens.

**Human review (2026-09-20)**: independently re-verified every claim
above (typecheck/build/test rerun clean, `npm publish --dry-run` output
inspected directly, a real `npm pack` + install into a directory outside
the monorepo + `--help`/`doctor`/`ui` all run for real, `ui`'s served
HTML confirmed to have no path back to the monorepo) — all held up. Then
pushed to trigger the actual unverified claim from item (1) above: a real
GitHub Actions run.

**A real bug found by that first CI run, not caught by this session's
own local verification**: `package-smoke` failed on every OS. Root
cause: `packages/cli`'s own `package.json` name is the unscoped
`"crewbench"` (it's the published npm package name, unlike every other
workspace package's `@crewbench/*` name) — but both the CI step and this
log's own prose used `pnpm --filter @crewbench/cli build:publish`, which
matches *zero* workspace projects. pnpm doesn't error on that; it prints
"Scope: 0 of 7 workspace projects" and exits 0, so the step showed green
while doing nothing, and `packages/cli/publish/` was never created — the
very next step then failed trying to `cd` into a directory that didn't
exist. This session's own local verification never caught it because it
ran `node scripts/build-publish.mjs` directly from inside
`packages/cli`, never through the `pnpm --filter` form CI actually uses
— a real gap in how "verified locally" was scoped, not a false claim
about what was actually run. Fixed: `.github/workflows/ci-node.yml` and
this log's own build:publish reference both now say `pnpm --filter
crewbench build:publish`. Re-pushed; a second real CI run is what
actually closes sign-off item (1) above, not this local fix alone.
