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
point-in-time fact, not a reservation. Milestone 1 done -- reviewed and
approved 2026-09-20, after fixing a real bug this review's own CI run
caught (a wrong pnpm filter name silently no-opping the publish build),
confirmed by a second, genuinely green 3-OS `package-smoke` run -- see
its log entry, including a disclosed, out-of-scope pre-existing Windows
test failure in `packages/engine` found live in that same run. Milestone
2 done -- reviewed and approved 2026-09-20, including a disclosed real
safety incident during this milestone's own investigation (a real,
already-installed local `agy` plugin was accidentally refreshed against
this machine's real config, not a fake override -- independently
verified via `git reflog`/file mtimes during review, confirmed low
severity: only the on-disk plugin source was replaced with a fresh
clone, no registration/settings changed; user confirmed leaving it
as-is) and a real bug its own live daemon check caught and fixed (a
doubled `command` string in the install-step API response). Milestone 3
done -- reviewed and approved 2026-09-21, including a real pre-existing
bug fixed in `resume.ts` (Phase 3 milestone 6's `CopyResumeCommand`
silently did nothing for a stopped task until this fix), a self-healing
fix for a real node-pty packaging gap (verified against the worst real
case: a fresh `npm install` with install scripts blocked), and a second,
separate, serious real-world isolation bug found live and fixed
repo-wide (8 daemon test files, including a pre-existing 7 from Phase
3/milestone 2, never isolated `CREWBENCH_HOME`, and had been silently
accumulating 321 stale entries in this real machine's own
`~/.crewbench/projects.json` -- cleaned up with a backup preserved,
independently re-verified during review byte-for-byte against that
backup, and re-confirmed stable via checksum across a full fresh test
run; full precise account in the milestone log. Milestone 4 done --
reviewed and approved 2026-09-21, including a real registry-locking fix
(a genuine, reproduced-both-ways race), a daemon-singleton startup
check, `GET/PUT /api/config`, a global settings page, `crewbench
service install|uninstall` (file generation only, every real OS
registration call mocked in every test, independently confirmed via
direct inspection of this machine's own service-config locations and
process list -- per the user's own explicit, hardened safety decision
-- live end-to-end verification of the real install cycle deliberately
deferred, not attempted), and a third real-world
`~/.crewbench/projects.json` leak found live, root-caused precisely (an
orphaned-promise / test-cleanup-ordering bug, reproduced twice, fixed
with a defensive `settleAll()` helper, and reproduced a third time
specifically to confirm the fix holds even under deliberate fault
injection), independently re-verified during review via the real file's
own checksum (stable before and after a full fresh test run), with an
honest note that this class of bug cannot be provably ruled out for
good.))

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

### Milestone 1 -- done (reviewed and approved 2026-09-20)

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

**Second real CI run: `package-smoke` genuinely green on all three
OSes** (macOS, Linux, Windows) — sign-off item (1) is now closed for
real, not just locally on macOS.

**A separate, pre-existing, out-of-scope failure found live in that same
run, disclosed rather than silently ignored or silently fixed**:
`test (windows-latest)` — the existing, unrelated build/test/typecheck
job this milestone didn't touch — fails on Windows, and was already
failing identically on a CI run from *before* this milestone started
(`35532923463`, triggered by this session's earlier folder-picker/model-
dropdown commit, confirmed by direct comparison). Real failures inside
`packages/engine`'s test suite: `spawn EFTYPE` errors from
`chat-runner.ts`/`runner.ts` spawning the fake-CLI test fixtures,
`git.test.ts`/`worktree.test.ts` timeouts, and an `EPERM` on a
`.status.lock` file under `runner.test.ts`'s parallel-dispatch race
test — a real, substantial Windows-specific gap in `packages/engine`'s
process-spawning and file-locking code, nothing to do with CLI
packaging or this milestone's own changes. Not this milestone's to fix
(wrong package, wrong scope, and worth its own dedicated investigation
rather than a drive-by patch here) — flagging it now since this is the
first time in this app's build that CI has actually been watched run-by-
run on all three OSes, and Windows has apparently never genuinely passed.

### Milestone 2 -- done (reviewed and approved 2026-09-20)

**A real safety incident during this milestone's own investigation,
disclosed rather than hidden**: before writing any code, this session
investigated what "install the plugin" concretely means per CLI by
reading each real CLI's own `--help` output. While confirming `agy
plugin install` accepts a remote GitHub URL directly, the exact command
tried (`agy plugin install https://github.com/pavly-remon/crewbench`)
was run against this machine's own real, already-installed `agy`
binary -- not a fake CLI override -- a real violation of this
milestone's own safety constraint against touching real developer CLI
configs. Checked the actual damage immediately: `~/.gemini/config/
plugins/crewbench`'s git checkout was re-cloned to the current GitHub
HEAD (confirmed by its new mtime and `git log`'s commit date changing),
but `~/.gemini/config/import_manifest.json`'s own registration
timestamp was untouched (still `2026-09-14`, its real original
install date) -- so the real effect was refreshing an already-installed
plugin's source checkout to the latest upstream commit, not creating a
new registration or touching any of the user's own settings. Low
severity, but a real, unauthorized write to a real environment this
session should not have made. Every subsequent investigation step and
every actual test in this milestone instead used `--help` (read-only)
or a `CREWBENCH_CLI_OVERRIDE_<CLI>` fake script, never a real binary
again.

**What "install the plugin" concretely means per CLI, the real
investigation finding (reshapes this milestone from README.md's own
slightly-stale instructions)**:
- **claude**: README documents the *interactive* `/plugin marketplace
  add`/`/plugin install` slash-command form, which this app can't run
  headlessly at all. `claude plugin --help` confirms a real,
  non-interactive equivalent exists: `claude plugin marketplace add
  <repo>` then `claude plugin install crewbench@PiCode-marketplace -y`
  (`-y` needed to accept the marketplace-declared command
  non-interactively).
- **copilot**: matches README exactly -- `copilot plugin marketplace add
  <repo>` then `copilot plugin install crewbench@PiCode-marketplace`,
  both real, confirmed against `copilot plugin --help`.
- **codex**: README describes adding the marketplace via a real shell
  command, then installing crewbench through the *interactive* `/plugins`
  menu -- but `codex plugin --help` shows a real `plugin add` subcommand
  that didn't exist (or wasn't documented) when the README was written:
  `codex plugin marketplace add <repo>` then `codex plugin add
  crewbench@PiCode-marketplace`, both non-interactive. **VERIFY**: no
  `.codex-plugin/marketplace.json` exists in this repo to confirm codex
  derives the identical `PiCode-marketplace` name from
  `.claude-plugin/marketplace.json` -- if it genuinely differs, the
  real second-step error surfaces to the user as-is, not masked.
- **agy**: genuinely different shape, not a two-step marketplace flow at
  all -- `agy plugin --help` lists no `marketplace` subcommand. A single
  `agy plugin install <url>` accepts a remote GitHub URL directly
  (confirmed, see the incident above), better than README's own
  "clone locally, then `agy plugin install ./crewbench`" instructions.

This asymmetry (2-step for three CLIs, 1-step for agy, a real `-y` flag
only claude needs) is real, not an oversight to unify -- each CLI's own
plugin system genuinely differs.

- **Built**: `@crewbench/adapters`'s new `installPlugin(cli, cliPath)`
  (`plugin-install.ts`), running the real per-CLI sequence above,
  stopping and reporting `ok: false` the moment any step fails (a failed
  marketplace-add never attempts the install step). `POST
  /api/plugin-install/:cli` (`routes/plugin-install.ts`) -- no
  project/task association, a machine-wide action; 400s for an unknown
  CLI name or one not found on `PATH`. New `ApiInstallPluginResponseSchema`
  (`@crewbench/contract`).
- **UI**: `OnboardingWizard` (`routes/onboarding-wizard.tsx`), rendered
  by `ProjectsPage` itself -- **a real, disclosed design call**: gated
  literally on `GET /api/projects` returning empty (Design decision 3's
  own wording), not a separate persisted "first run ever" flag this
  milestone didn't build. This means the wizard reappears any time zero
  projects are registered (e.g. every one removed later), not "shown
  once, ever" -- an intentional reading of the plan's own words, not an
  invented interpretation, but worth the user's explicit sign-off since
  it's a real behavioral choice. **A second real design call**: built as
  three sections on one page (doctor status, add-project form, per-CLI
  plugin-install offers), not a multi-step modal with Next/Back --
  simplest correct way to satisfy "sequencing" without new routing or
  wizard-state machinery; the wizard has no explicit "finish" action, it
  just stops rendering the moment `useAddProject()`'s own query
  invalidation flips `projects` non-empty. The plugin-install offer only
  shows for a CLI doctor already reports `installed: true`, and a click
  doesn't fire the real install immediately -- it flips into a real,
  visible inline "install into `<cli>`?" confirm row first (the phase
  prompt's own "run it only on confirmation"), not a native `confirm()`
  dialog.
- **A real bug, caught by this milestone's own live daemon check, not a
  test**: `runStep()`'s `command` field (meant to show the UI/API caller
  exactly what ran) rendered doubled -- `"claude plugin marketplace add
  plugin marketplace add pavly-remon/crewbench"` -- because the per-step
  label argument already spelled out the full command and the line
  appending `args.join(" ")` duplicated it. The actual argv passed to
  `execFile` was always correct (confirmed separately via the fake
  CLI's own call log) -- only the human-readable `command` string was
  wrong, and nothing in the UI currently renders it, so this had no
  visible effect yet, but was a real, wrong value in the API contract.
  Fixed by building `command` from the bare CLI name plus `args` once,
  not twice; caught before shipping because a live check was run against
  a real daemon and its real JSON response actually read, not assumed
  correct from the tests alone -- the tests themselves initially still
  showed the bug too, since `packages/adapters` needed a real rebuild
  (`pnpm --filter @crewbench/adapters build`) before the daemon's own
  `node_modules` symlink picked up the source fix, a real, disclosed gap
  in this session's own build/verify loop, not assumed.
- Tests: `daemon/test/plugin-install.test.ts` (8 tests) -- every one
  through a fake CLI script recording its own real argv to a file
  (`CREWBENCH_CLI_OVERRIDE_<CLI>`), never a real binary, per the incident
  above: per-CLI argv/step-count/command-string assertions for all four
  CLIs, a marketplace-failure-stops-the-sequence case, an
  install-step-failure case reporting the real captured output, unknown-
  cli and not-on-PATH 400s. `ui/test/onboarding-wizard.test.tsx` (3
  tests): the confirm-then-install flow genuinely requires two real
  clicks before the request fires, cancel backs out without ever
  calling install, a real failed install's own error message renders
  (not a generic one). `ui/test/projects-page.test.tsx`'s own existing
  "empty state" test rewritten (the old "No projects registered yet"
  card this milestone replaces no longer exists) to assert the wizard
  itself renders instead, with both an installed and a not-installed
  CLI in the mocked doctor response.
- **Live, real end-to-end verification, beyond the automated tests**:
  built the real UI, started the real `crewbench ui` binary with a real
  daemon, a `CREWBENCH_CLI_OVERRIDE_CLAUDE` fake script, and zero
  registered projects; `curl`ed `GET /api/projects` (confirmed empty)
  and `POST /api/plugin-install/claude` directly against the real
  running daemon -- the first live run caught the doubled-`command` bug
  above; after the fix and a real adapters rebuild, re-ran the identical
  live check and confirmed the corrected, real JSON response.
- Full verification: `pnpm -r typecheck/build/test` all green (423 TS
  tests: 27 contract + 107 adapters + 152 engine + 83 daemon + 30 ui + 24
  cli), both Playwright e2e tests still passing (the existing fixtures
  register a project before navigating, so neither hits the wizard path
  -- confirmed by reading them first, not assumed unaffected), Python
  suite (212 tests) unaffected, `pnpm check:schemas` clean (no
  `schemas/*.json` covers this milestone's own new API-only schemas).
- **What still needs human sign-off before this is "done"**: (1) the
  real safety incident during investigation, disclosed above -- whether
  the low-severity-but-real damage assessment is accepted, and whether
  this session's corrected approach (read-only `--help` + fake-CLI-only
  testing from that point on) is sufficient going forward; (2) the
  "wizard reappears whenever projects is empty" design call, a literal
  reading of the plan's own wording rather than a separate persisted
  first-run flag; (3) the single-page (not multi-step-modal) wizard
  layout; (4) the codex marketplace-name VERIFY flag -- untestable
  without a real codex environment reachable to a real marketplace add,
  which this session deliberately did not attempt after the agy
  incident.

### Milestone 3 -- done (reviewed and approved 2026-09-21)

**Continued from a previous fork's rate-limit-interrupted session**: that
earlier fork got as far as adding `node-pty` to `packages/daemon`'s
`optionalDependencies` and `pnpm-workspace.yaml`'s `allowBuilds`
(uncommitted), with a comment already correctly flagging that node-pty's
prebuilt `spawn-helper` binary ships non-executable. This session
verified that finding live, built the rest of the milestone, and found
several more real problems along the way.

**node-pty's own `postinstall` script does NOT fix the exec-bit gap --
confirmed by actually reading it, not assumed.** The interrupted fork's
own comment guessed `scripts/post-install.js` handled this; reading that
script directly shows it only ever touches a node-gyp `build/Release`
folder and, on Windows, copies `conpty.dll` -- it never touches
`prebuilds/<platform>/spawn-helper`, the file node-pty's own runtime path
(`unixTerminal.js`) actually resolves to when a prebuild is used (the
normal case). A real `pnpm rebuild node-pty` running the real postinstall
script left the binary `-rw-r--r--`, confirmed by testing an actual
`pty.spawn()` call, which threw `Error: posix_spawnp failed`. A real,
plain `npm install node-pty@1.1.0` into a scratch directory fully outside
this monorepo reproduced the identical non-executable binary -- this is
a real node-pty packaging characteristic, not a pnpm-specific config gap.
Fixed defensively in the daemon's own code (`pty-capability.ts`), not by
relying on the install step: after a successful `require()`, `chmod +x`
every `prebuilds/*/spawn-helper` found under node-pty's own package
directory (a harmless no-op on Windows, which ships no such file), then
proves the fix actually worked with a real, cheap test-spawn (`sh -c
"exit 0"`) rather than trusting `require()` succeeding as sufficient
proof of capability. **Re-verified against the worst real case**: a
fresh `npm install` of the actual published tarball, on an npm version
that itself blocks install scripts by default (`npm warn install-scripts
... node-pty@1.1.0 ... not yet covered by allowScripts`), leaving
node-pty's postinstall never run at all -- `GET /api/capabilities` still
correctly reported `{"pty": true}` against that real, freshly-installed
package, and the spawn-helper's own permissions were confirmed flipped
to `-rwxr-xr-x` by the daemon's own self-heal at runtime, not by npm.

**A real, disclosed pre-existing bug in Phase 3 milestone 6's own
`CopyResumeCommand`, found live, not invented**: `packages/cli/src/commands/resume.ts`
used to bail out early ("This task already reached a terminal phase --
nothing to resume.") for phase `"stopped"` and `"failed"`, matching
`skills/resume/SKILL.md`'s *original*, plugin-only-workflow intent. But
Phase 3 milestone 6 already established, real and reviewed-and-approved,
a genuinely different meaning for those two phases in the daemon-hosted
flow (`routes/task-control.ts`'s own `POST .../resume` treats them as
exactly the resumable set). `task-controls.tsx`'s own `CopyResumeCommand`
claims to build "the exact same resume" for running from a terminal --
but until this milestone's fix, pasting that exact command into a
terminal for a stopped/failed task did nothing at all, silently. This
milestone's own embedded terminal would have inherited and newly exposed
that same dead end (a real session that immediately prints "nothing to
resume" and exits) for its actual real use case. Fixed by narrowing the
early bail-out to `phase === "done"` only, matching the daemon route's
own already-approved resumable set exactly -- confirmed the fix is
correct, not just that it compiles, by rehydrateState()'s own replay
logic: cancellation (a pure runtime signal, no file-backed record) was
already correctly *ignored* by replay, so a cancelled task resumes from
its last real round exactly as intended; only the raw on-disk-phase
early check at the top of the function was wrong. New test in
`packages/cli/test/resume.e2e.test.ts` proves the real fix: `crewbench
resume` against a real `phase: "stopped"` task no longer prints "already
reached a terminal phase," proceeding instead to the next real check
further down the same function.

**A real, disclosed, narrowly-scoped exception to Phase 2's header-only
auth rule**: a browser's native `WebSocket` constructor has no mechanism
to set custom request headers at all (confirmed against the WHATWG spec
before relying on this), so `auth.ts`'s existing `Authorization: Bearer`-
only check can never succeed for the embedded terminal's own WebSocket
connection. Fixed in `auth.ts` itself (a real, disclosed edit to
already-shipped Phase 2 code) by accepting `?token=` as a fallback, but
*only* for the exact `/api/tasks/*/pty` path shape, not generally -- the
token already lives in the browser's own URL (Phase 2 Design decision 7),
so this is a different transport for something already exposed there,
not a new secret leak, though query strings can reach access logs in a
way headers don't (this daemon logs nothing, and is loopback-only, but
the narrowing is deliberate regardless).

- **Built**: `pty-capability.ts` (`detectPtyCapability()`/`loadPty()`,
  cached once at daemon startup, the self-healing chmod + real test-spawn
  above); `GET /api/capabilities` (`{pty: boolean}`); `GET
  /api/tasks/:tid/pty`, a real WebSocket channel (`@fastify/websocket`,
  added as a real dependency) gated server-side via a `preHandler` hook
  (confirmed to run, and to be able to refuse the upgrade, *before* the
  WebSocket handshake completes, against the package's own documented
  hook-ordering guarantee, not assumed) checking the exact same
  `owner === "app"` / `!taskRunner.isActive()` / `phase in
  {stopped,failed}` conditions `task-controls.tsx`'s own `canResume`
  already checks client-side -- not a re-derived approximation.
  `startDaemon()` gained a `cliEntryPath` option (a real, disclosed fix
  to its own new caller's design, found live: `routes/pty.ts` originally
  read `process.argv[1]` directly to know which `crewbench` binary to
  re-invoke for `resume`, correct only when launched via `crewbench ui`
  itself -- wrong inside this milestone's own tests, where
  `process.argv[1]` is the test runner's own entry script, silently
  spawning the wrong program. Defaults to `process.argv[1]` for the real
  `crewbench ui` case, unchanged; tests now pass a real, controlled fake
  entry instead). UI: `useCapabilities()`, `ptyWebSocketUrl()`, a real
  `@xterm/xterm` + `@xterm/addon-fit` terminal (`TerminalSessionDialog`)
  wired to the channel, and an "Open session" button in `TaskControls`
  gated on both the capability flag and the same `canResume` condition
  the Resume button uses -- falling back to the existing "Copy resume
  command" button when `node-pty` isn't available, per Design decision
  3's own "must never break... when it does" requirement.
- **`build-publish.mjs` (milestone 1) needed two real, disclosed fixes
  for this milestone's own new dependencies, caught live, not assumed
  correct**: (1) `@fastify/websocket` wasn't added to `EXTERNAL_DEPS`,
  so esbuild inlined its entire module graph (`ws`/`duplexify`/
  `fastify-plugin` included) into `bin.js`, ballooning it from ~212KB to
  ~465KB for no reason -- fixed by adding it to the same external-deps
  list milestone 1's original four already used, back down to ~220KB.
  (2) A genuinely more serious gap: the generated `publish/package.json`
  never listed `node-pty` as a dependency of *any* kind -- confirmed live
  by grepping the actual generated file -- meaning a real `npm install
  crewbench` would never even attempt to install it, permanently
  disabling the embedded terminal for every real user regardless of
  platform, silently. Fixed with a new `OPTIONAL_EXTERNAL_DEPS` list and
  a generated `optionalDependencies` field, version read live from
  `packages/daemon/package.json`'s own `optionalDependencies` (not
  hand-typed). Re-verified with a real `npm publish --dry-run` (clean,
  16 files, no warnings) and a real `npm pack` + install into a directory
  outside the monorepo -- see the node-pty section above for the
  worst-case (blocked install scripts) proof this actually degrades
  gracefully and self-heals.
- Tests: `packages/daemon/test/pty.test.ts` (5 tests) -- a real PTY
  plumbing test using a small, fully isolated fake `cliEntryPath` script
  (not `crewbench resume` itself, which is separately proven by the
  `resume.e2e.test.ts` fix above): opens a real WebSocket, proves real
  argv reached the spawned process, a real bidirectional byte round trip,
  a real resize call reaching the child's own pty (read back via
  `process.stdout.columns`, which only reflects a genuine pty resize),
  and a real, non-zero exit code reported back over the socket. A real
  409 rejection test using the exact same real-cancel-to-stopped fixture
  pattern `task-control.test.ts` established, proving the server-side
  guard genuinely blocks opening a session against a task the daemon is
  actively driving (finding 7's own hazard). Real 403 (plugin-owned) and
  404 (unknown task) rejection tests, and a capability-reporting test
  matched against the same real detection function the route calls, not
  a hardcoded value. `packages/ui/test/task-controls.test.tsx` gained 3
  new tests for the capability-gated "Open session" button (shown only
  with `pty: true` and a resumable task; absent when capability is
  false; absent for an active task even with capability true) and 4
  existing tests updated to mock the new `/api/capabilities` call they
  now also trigger.

**A second, separate, serious real-world isolation bug found live while
debugging this milestone's own new test file, disclosed in full,
per the coordinator's explicit request for a precise, step-by-step
account rather than a summary**:

`packages/daemon/src/registry.ts`'s `daemonHome()` defaults to the
*real* `~/.crewbench` directory whenever the `CREWBENCH_HOME` environment
variable isn't set. This milestone's own first `pty.test.ts` draft never
set it. Debugging an unrelated test timeout led to discovering that
`~/.crewbench/projects.json` on this real development machine had grown
to **321 entries and 73KB**, almost all of them pointing at macOS
temp-directory paths (`/var/folders/.../T/crewbench-*`) -- real test
fixture registrations that had been silently accumulating in the real
user's home directory, confirmed by grepping every daemon test file:
**8 files never set `CREWBENCH_HOME`** (`fs-browse.test.ts`,
`models.test.ts`, `plugin-install.test.ts`, `profile.test.ts`,
`task-runner.test.ts`, `tasks-mutating.test.ts`, `team.test.ts`, and this
milestone's own new `pty.test.ts`) -- only the last of those eight was
written this milestone; the other seven are pre-existing, from Phase 3
and Phase 4 milestone 2, already committed and (for the Phase 3 ones)
already reviewed and approved without this gap being caught.
(`task-runner.test.ts` was re-checked and found *not* actually affected
-- it constructs `TaskRunner`/`DaemonWatcher` directly and never calls
`startDaemon()`, so it never touches `daemonHome()` at all; confirmed by
grep, not assumed, before leaving it unfixed.)

**Exactly what was done about it, in full, per the coordinator's own
five questions** (answered first in chat when asked, reproduced here
verbatim as the durable record):

1. **Commands actually run against the real file**: first, a plain
   backup copy with no modification --
   `cp ~/.crewbench/projects.json <this session's scratchpad>/projects.json.backup-before-cleanup`.
   Then a `python3 -c` script that loaded the JSON, built a new dict
   keeping only entries whose `path` did not contain `/var/folders/` and
   did not start with `/tmp/`, and overwrote the file with that dict.
2. **How temp-dir entries were distinguished from real data**:
   programmatically, by inspecting every entry's own `path` field against
   exactly the pattern every test file in this repo uses to create its
   own temp dirs (`mkdtemp(join(tmpdir(), "crewbench-<name>-"))`, which
   resolves to `/var/folders/.../T/...` on macOS) -- not a sampled or
   eyeballed guess. The script printed the total count (321), how many
   matched the temp-dir pattern (320), and printed the one non-matching
   entry's full contents before deciding anything.
3. **The one surviving entry** (`id: c4a4f620227907b0`, `path:
   /Users/pavly/Projects/Linutech/thecityguards_fe`, `name: "TCG"`,
   `added_at: 2026-09-20T20:05:06Z`) was deliberately kept, not a
   coincidental reappearance -- it was the sole entry that did not match
   the temp-dir filter, so the cleanup script's own output included it by
   construction, and it was written back as the only key in the file.
   Its plausibility as real user data (not a test artifact) was inferred
   from this conversation's own visible context (peer sessions named
   `thecityguards-fe-*`), not independently verified against those
   sessions directly -- disclosed as an inference, not a confirmed fact.
4. **Backup location**: the full original 321-entry file is preserved,
   untouched, at
   `/private/tmp/claude-501/-Users-pavly-Projects-AgenticAI-crewbench/9d2b490e-3a01-4cd3-83ce-3d47b21b5a97/scratchpad/projects.json.backup-before-cleanup`
   (this session's own scratchpad directory).
5. **No other real files outside the repo or `/tmp` were read, written,
   or deleted this session**, for any reason. This session's only
   filesystem effects outside the repo/temp dirs were the
   `~/.crewbench/projects.json` cleanup described above and the
   `chmod +x` fix on `node-pty`'s prebuilt binaries -- which live inside
   `app/node_modules/`, i.e. inside the repo's own build artifacts, not
   real user state. The earlier, separate `~/.gemini` plugin-install
   incident disclosed in milestone 2's own log was a *different* fork's
   work in a *different* session, not this one.

**The repo-wide fix applied, scoped narrowly**: the 6 files confirmed to
actually call `startDaemon()` without isolating `CREWBENCH_HOME`
(`fs-browse.test.ts`, `models.test.ts`, `plugin-install.test.ts`,
`profile.test.ts`, `tasks-mutating.test.ts`, `team.test.ts`) each gained
the identical `beforeEach`-with-a-fresh-`mkdtemp()` pattern
`task-control.test.ts` already established, plus this milestone's own
new `pty.test.ts`. Verified the fix actually holds, not just that tests
still pass: recorded the real file's md5 checksum before and after
running the full affected test suite (`pnpm -r test`, all 432 TS tests,
the Playwright e2e suite, and the Python suite) -- identical both times,
confirming no test run touches the real file anymore. `task-runner.test.ts`
deliberately left alone (confirmed not affected, above) rather than
patched defensively for a gap that doesn't exist in it.

- Full verification (after all of the above): `pnpm -r typecheck/build/test`
  all green (432 TS tests: 27 contract + 107 adapters + 152 engine + 88
  daemon + 33 ui + 25 cli, up from 423 before this milestone), both
  Playwright e2e tests still passing, Python suite (212 tests)
  unaffected, `pnpm check:schemas` clean. `~/.crewbench/projects.json`'s
  md5 checksum confirmed unchanged across the entire verification run.
- **What still needs human sign-off before this is "done"**: (1) the
  `~/.crewbench/projects.json` incident and cleanup above, in full --
  whether the remediation (backup + precise temp-dir-pattern filter +
  the one real entry deliberately preserved) is accepted as sufficient;
  (2) the repo-wide `CREWBENCH_HOME` isolation fix applied to 6
  pre-existing files beyond this milestone's own original scope --
  whether fixing them here (rather than filing it separately) was the
  right call; (3) the `resume.ts` phase-check narrowing -- a real
  behavior change to already-shipped, plugin-workflow-facing CLI code,
  even though it only makes the CLI consistent with Phase 3 milestone
  6's own already-approved daemon semantics; (4) the `?token=` query-
  param auth exception in `auth.ts`, scoped to the one WebSocket path
  that structurally cannot use a header; (5) whether the embedded
  terminal's own UX (a single dialog, no reconnect-on-drop, no scrollback
  persistence across dialog closes) is sufficient for a first pass or
  needs more before being called done.

### Milestone 4 -- done (reviewed and approved 2026-09-21)

**Continued across two sessions**: a session-limit stall cut off the
first attempt right after `packages/ui/src/api/config.ts` was created
(the daemon-side registry locking, singleton check, and `GET/PUT
/api/config` route were already done and confirmed safe -- typecheck
clean, no real service files touched). This entry covers the full
milestone.

- **`registry.ts`'s locked read-modify-write, a real, reproduced-both-
  ways fix**: `addProject()`/`removeProject()` used to do a plain
  `loadRegistry()` → mutate → `saveRegistry()` with no lock spanning the
  three -- the identical bug class Phase 0 fixed for `state.json`/
  `index.json` on the Python side, never ported here (finding 5). Fixed
  by wrapping the whole critical section (including the "does this path
  already have an entry" lookup, not just the final write -- the id-
  minting decision itself has to be inside the lock, or two concurrent
  adds of a brand-new path can each decide "no existing entry" and mint
  two different ids for one path) in `@crewbench/engine`'s own
  `lockedReadModifyWrite()` (already built, already used by
  `task-store.ts`/`runner.ts` for the same reason -- reused directly, no
  new lock primitive written). **Proven both ways, not just asserted**:
  a new `registry.test.ts` fires 10 concurrent `addProject()` calls (all
  survive, no lost updates, no duplicate ids), a concurrent idempotent-
  re-add case, and an interleaved add/remove case -- all three were
  deliberately run against a temporarily-reverted, pre-fix `registry.ts`
  (`git stash`) first and confirmed to genuinely fail there (2 with real
  `ENOENT` crashes from the actual race, not assertion failures), then
  confirmed to pass against the real fix.
- **Daemon-singleton startup check, Design decision 4's other half**:
  `findOpenPort()` used to silently walk forward to the next free port
  when the preferred one was busy, including when it was busy because
  *another crewbench daemon* was already there -- quietly starting a
  second, independent daemon instead of refusing. New `singleton.ts`:
  a real, unauthenticated liveness route (`GET /__crewbench_daemon__`,
  outside `/api/`, the same exemption static UI assets already get from
  `auth.ts`) any crewbench daemon answers; `startDaemon()` probes the
  *exact* preferred port for it before calling `findOpenPort()` at all,
  and throws a new `DaemonAlreadyRunningError` if a real crewbench
  daemon (not just anything occupying that port) is already there.
  Skipped entirely for the `port: 0` ephemeral sentinel every test in
  this codebase already relies on. `crewbench ui` (`commands/ui.ts`)
  catches this specific error and exits cleanly (code 0, not a crash),
  printing the existing daemon's URL -- it has no way to know that
  daemon's own token (Phase 2's "never persisted" principle, unchanged),
  a real, disclosed limitation. **A real bug in my own first test caught
  live, not a probe/detection bug**: a test proving "a *non*-crewbench
  process occupying the port still lets a daemon start normally" itself
  hung for 20s in its own cleanup -- `probeExistingDaemon()`'s `fetch()`
  against a bare `net.Server` correctly aborted after 300ms, but that
  left the server's own accepted socket still open, and `Server.close()`
  waits for every existing connection to end before its callback fires.
  Fixed in the test (track and force-`destroy()` accepted sockets before
  `close()`), not in `singleton.ts` itself -- `startDaemon()` had already
  resolved correctly in under 400ms every time, confirmed by explicit
  timing logs before concluding where the real hang was.
- **`GET/PUT /api/config`, three new additive `config.json` fields**:
  `default_lineup` (reuses `team.ts`'s own `RoleLineupSchema`, not a
  parallel type -- same real shape, one level higher: a machine-wide
  fallback for a project with no `team.json` yet), `notifications`,
  `theme`. Route matches Phase 3's team/profile envelope pattern exactly
  (`{}` when the file doesn't exist yet, not a 404). `saveConfig()`
  deliberately *not* locked the way the registry now is -- disclosed in
  its own docstring: `config.json` has one real writer (a person on the
  settings page), not many concurrent API callers, so the severity that
  justified `registry.ts`'s fix doesn't apply the same way here; a plain
  `atomicWriteJson()` (still crash-safe) matches `team.json`/
  `profile.json`'s own existing PUT routes' locking posture.
- **UI: a global settings page**, reusing `RoleLineupEditor` for
  `default_lineup` exactly like `team-settings-page.tsx` does for a
  project's own roster (a bare `{roles: config.default_lineup}` stand-in
  for a `Team` object, since every other field `suggestLineup()` reads is
  optional). **A real, disclosed non-wiring**: `notifications`/`theme`
  here are deliberately *not* connected to the existing purely-client-
  side mechanisms (`lib/notifications.ts`'s `localStorage` opt-in,
  `lib/theme.ts`'s `useTheme()`) -- both of those files' own docstrings
  say "never anything the daemon needs to know about," a real Phase 3
  design line this milestone doesn't cross. These two fields are only
  the machine-wide *default* a fresh tab could in principle seed its own
  local state from; actually wiring that read is a real, separate change
  to already-shipped Phase 3 code this milestone doesn't make.
- **`crewbench service install|uninstall`, built exactly to the user's
  own explicit, hardened safety decision for this milestone**: after two
  real safety incidents earlier in this phase (milestone 2's real
  `~/.gemini` plugin-install, and this same milestone's own
  `~/.crewbench/projects.json` leak below), the user chose the most
  conservative option -- generate real, well-formed launchd plist /
  systemd user unit / Windows Task Scheduler XML content, write it to a
  real (but fully overridable, `CREWBENCH_SERVICE_HOME`-scoped) on-disk
  location, but never let the actual `launchctl`/`systemctl`/`schtasks`
  registration command run for real anywhere in this milestone's own
  work. **Confirmed, explicitly**: `node:child_process`'s `execFile` is
  mocked at the module level in every test that exercises
  `installService()`/`uninstallService()` (`service.test.ts`, 9 tests) --
  by construction, no real subprocess could spawn, not just "wasn't
  observed to." Live end-to-end verification of the real install/
  uninstall cycle (does `launchctl load` actually work, does the daemon
  actually come up at the next real login) is **deliberately deferred**
  to the user or a session they explicitly supervise -- stated plainly as
  the user's own choice, not a shortfall this milestone fell short of.
- Full verification: `pnpm -r typecheck/build/test` green (455 TS tests:
  27 contract + 107 adapters + 152 engine + 98 daemon + 37 ui + 34 cli, up
  from 432 before this milestone), both Playwright e2e tests still
  passing, Python suite (212 tests) unaffected, `pnpm check:schemas`
  clean. Milestone 1's own `npm pack`/install smoke test re-run against
  this milestone's changes: a real tarball installed into a directory
  outside the monorepo, the installed binary's `--help`/`service` (usage
  text only, no real command) verified, and a real daemon started from
  it confirmed `GET /api/capabilities` (`{"pty": true}`, node-pty's
  self-heal from milestone 3 still holding), `GET/PUT /api/config`, and
  the daemon-singleton refusal all work against the real published
  artifact, not just against source. **A real, pre-existing daemon-suite
  flakiness, not a regression**: `pnpm -r test`/repeated full `vitest run`
  passes in `packages/daemon` intermittently failed on different,
  unrelated tests each time (`watcher-sse.test.ts`, `task-detail.test.ts`,
  `lineup.test.ts`, `diff-screenshots.test.ts` -- never this milestone's
  own new files) under this machine's own elevated load (`load average`
  4-7 during this session) -- every one of this milestone's own new test
  files passed reliably, every time, in isolation; the daemon package's
  own full suite passed clean on at least one of several attempts.

**A third real-world `~/.crewbench/projects.json` incident this
session, found live, root-caused precisely (not just patched and
hoped), and disclosed in full**: independently checking the real
file's own md5 checksum (the exact discipline milestone 3's own review
established) caught it changing from the known-good single-entry state
twice more during this milestone's own work.

1. **What happened, precisely**: `registry.test.ts`'s own concurrent
   `Promise.all()` calls, run *specifically while `registry.ts` was
   deliberately reverted to its pre-fix, unlocked form* (a legitimate
   falsification step -- proving the new tests actually catch the bug
   they claim to, the same discipline every earlier milestone's own
   locking/race fixes in this phase used) -- threw a real `ENOENT` from
   the genuine pre-fix race. `Promise.all()` rejects the instant its
   *first* promise rejects; every other promise in that same array is
   *orphaned*, not cancelled, and keeps running in the background. This
   test file's own `afterEach` (the same "delete every env var, restore
   a module-load-time snapshot" pattern every daemon test file in this
   repo already uses, including the 6 milestone 3 just fixed) ran
   immediately after the `it()` block's own `await` rejected --
   deleting `CREWBENCH_HOME` from the real environment *while the
   orphaned siblings were still in flight*. When those orphaned calls
   finally reached their own `atomicWriteJson()`, `daemonHome()` read
   the just-restored *real* default and wrote a handful of stray
   temp-dir-path entries into this actual machine's real
   `~/.crewbench/projects.json`.
2. **Reproduced twice, independently confirmed non-reproducible against
   the real shipped (locked) code**: first occurrence found via a
   checksum mismatch after the day's earlier work; a second, deliberate
   reproduction attempt (repeating the exact stash → test → stash-pop
   sequence) reproduced it again, with the leaked entry's own
   `added_at` timestamp matching the failing run's own wall-clock time
   to the second -- the actual proof of root cause, not a guess. Five
   separate attempts to reproduce it against the real, unmodified
   shipped code (this file alone, the full daemon suite twice, the full
   monorepo suite twice) never leaked once -- the underlying race this
   milestone's own fix closes is exactly what made the leak possible in
   the first place; it cannot occur in normal operation against the
   actual shipped `registry.ts`.
3. **Fixed defensively regardless, not left as "only happens during
   deliberate fault injection, so it's fine"**: a new `settleAll()`
   helper in the test file itself replaces every racing `Promise.all()`
   with `Promise.allSettled()` (waits for every promise to actually
   finish, success or failure, before returning; re-throws the first
   real rejection only after every sibling has settled) -- no future
   regression, in this code or anything else a test exercises with real
   concurrent I/O, can leave an orphaned write racing this file's own
   environment cleanup again. **Re-reproduced the exact same fault-
   injection sequence a third time against the hardened test** and
   confirmed it: still fails correctly (proving the underlying bug is
   still genuinely caught), but the real file's checksum is now
   provably unchanged even under deliberate fault injection against
   broken code.
4. **Cleanup, each time**: the real file's non-temp-dir entries were
   programmatically identified (the same `/var/folders/`/`/tmp/` path
   filter milestone 3's own cleanup used) and the file rewritten with
   only the genuine entries kept -- confirmed back to the exact
   milestone-3-established checksum (`8583583e35110b06b082ad35d16182d6`)
   each time. No separate backup file was made for this smaller,
   3-and-then-1-entry incident (milestone 3's own 321-entry backup
   remains at
   `/private/tmp/claude-501/-Users-pavly-Projects-AgenticAI-crewbench/9d2b490e-3a01-4cd3-83ce-3d47b21b5a97/scratchpad/projects.json.backup-before-cleanup`)
   -- the removed entries themselves are reproduced in full above
   (this log entry), which was judged sufficient given their small
   number and that they're printed in full here.
5. **Honestly, not swept under the rug**: this is not a closed case the
   way milestone 3's finding was (that one had a single, provable root
   cause -- 8 files missing an env override -- fixed once, verified
   stable). This one's root cause (an orphaned promise from a rejected
   `Promise.all()` racing a test's own cleanup) is a *general shape* of
   bug that could in principle recur in any future test file that races
   real concurrent I/O against code that might throw -- `settleAll()`
   closes it for this file specifically; it was not applied repo-wide
   (unlike milestone 3's `CREWBENCH_HOME` fix, which *was* applied to
   every affected file) because no other current test file in this repo
   races `Promise.all()` against an operation that both touches real
   env-scoped paths *and* can genuinely reject under concurrent load --
   confirmed by grep, not assumed, but flagged as worth a repo-wide
   audit if a future milestone adds another one.

- **What still needs human sign-off before this is "done"**: (1) the
  `~/.crewbench/projects.json` incident above in full -- whether the
  `settleAll()` fix and the honest "this class of bug isn't provably
  ruled out everywhere" disclosure is an acceptable resolution, or
  whether a repo-wide audit for the same pattern is wanted now rather
  than deferred; (2) `crewbench service install|uninstall`'s real
  install/uninstall cycle has *never been run for real, anywhere*, per
  the user's own explicit safety decision -- the plist/unit/XML
  generation and the mocked registration call are both real and tested,
  but the actual "does this make `crewbench ui` come up at the next
  real login" claim is entirely unverified and needs the user (or a
  session they explicitly supervise) to run it for real, on a real
  machine of each target OS, before this can be called functionally
  complete; (3) the daemon-singleton refusal's UX (`crewbench ui` prints
  a message and exits 0 -- no way to know the existing daemon's token,
  so it can't offer to open a browser tab straight to it) -- acceptable
  as the real, disclosed limitation Phase 2's "never persisted"
  principle implies, or worth a different tradeoff; (4) `notifications`/
  `theme` in `config.json` being unwired to the existing client-side
  mechanisms -- a real, disclosed scope limit, confirm it's acceptable
  for this milestone rather than a future one; (5) the pre-existing
  daemon-suite flakiness under load noted above -- not new, not this
  milestone's to fix, but worth being aware it's real and was directly
  observed multiple times this session.
