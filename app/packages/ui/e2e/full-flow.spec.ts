import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { startDaemon, type DaemonHandle } from "@crewbench/daemon";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const VALID_SPEC = {
  title: "Add a reverse function",
  description: "Add a function reverse(str) in src/reverse.js.",
  acceptance_criteria: ["reverse('abc') returns 'cba'"],
  affected_areas: [],
  out_of_scope: [],
  needs_design: false,
  constraints: [],
};

/** One fake `claude` binary standing in for the real CLI across the
 * *entire* flow this test drives -- scoping (both turns), the developer
 * round, and tester + code-reviewer (dispatched together) -- since
 * `CREWBENCH_CLI_OVERRIDE_CLAUDE` is a single process-wide override for
 * whichever daemon this test starts, the same real-subprocess pattern
 * `packages/daemon/test/task-control.test.ts`'s own `fakeMultiRoleCli()`
 * and `scoping.test.ts`'s own `fakeClaudeCli()` already use, merged into
 * one script since one daemon process can only have one override active
 * at a time. Branches on a keyword unique to each prompt shape (the same
 * technique those two test files already use independently) except for
 * scoping, which needs real per-turn state (a plain conversation has no
 * such keyword) -- tracked in a state file on disk, since each turn is a
 * genuinely separate subprocess invocation with no shared memory. */
async function fakeLeadAndCrewCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-e2e-fullflow-fakecli-"));
  const path = join(dir, "fake-claude.cjs");
  const script = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf-8");
  if (prompt.includes("tests_run")) {
    respond({ verdict: "pass", summary: "all good", tests_run: ["a.test.js"], tests_added: [], failures: [], blocked: [] });
  } else if (prompt.includes("previous_issues")) {
    respond({ verdict: "approve", summary: "looks good", issues: [], blocked: [] });
  } else if (prompt.includes("files_changed")) {
    require("fs").mkdirSync("src", { recursive: true });
    require("fs").writeFileSync("src/reverse.js", "module.exports = function reverse(str) { return str.split('').reverse().join(''); };");
    respond({ status: "done", summary: "did the thing", files_changed: ["src/reverse.js"], assumptions: [], questions: [], blocked: [] });
  } else {
    // Scoping: turn 0 asks a clarifying question (plain text, not JSON --
    // tryParseTaskSpec() must genuinely fail to parse it as a spec, the
    // real "still gathering info" case), turn 1+ replies with the spec.
    const stateFile = ${JSON.stringify(join(dir, "scoping-turn.txt"))};
    let turn = 0;
    try { turn = Number(require("fs").readFileSync(stateFile, "utf-8")); } catch {}
    require("fs").writeFileSync(stateFile, String(turn + 1));
    const text = turn === 0 ? "What should the function do exactly?" : ${JSON.stringify(JSON.stringify(VALID_SPEC))};
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "e2e-fullflow-session", model: "m" }));
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", result: text }));
    return;
  }
  function respond(result) {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "e2e-fullflow-session", model: "m" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", structured_output: result, permission_denials: [] }));
  }
});
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return path;
}

interface FullFlowFixture {
  daemon: DaemonHandle;
  projectId: string;
}

async function startFullFlowFixture(): Promise<FullFlowFixture> {
  const home = await mkdtemp(join(tmpdir(), "crewbench-e2e-fullflow-home-"));
  process.env.CREWBENCH_HOME = home;
  process.env.CREWBENCH_UI_DIST = resolve(__dirname, "..", "dist");
  process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = await fakeLeadAndCrewCli();

  const repo = await mkdtemp(join(tmpdir(), "crewbench-e2e-fullflow-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "E2E"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "hello\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const daemon = await startDaemon({ port: 0 });
  const addRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: repo, name: "e2e-fullflow" }),
  });
  const project = (await addRes.json()) as { id: string };

  return { daemon, projectId: project.id };
}

let fixture: FullFlowFixture;
const savedEnv = { ...process.env };

test.beforeAll(async () => {
  fixture = await startFullFlowFixture();
});

test.afterAll(async () => {
  await fixture.daemon.close();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function baseUrl(): string {
  return `http://127.0.0.1:${fixture.daemon.port}`;
}

async function goto(page: Page, path: string, withToken = false): Promise<void> {
  const url = withToken ? `${baseUrl()}${path}#token=${fixture.daemon.token}` : `${baseUrl()}${path}`;
  await page.goto(url);
}

/** The actual centerpiece of Phase 3 milestone 6: drives create -> scope
 * -> finalize -> lineup -> a real fix round -> a real commit approval
 * through the real UI against a real daemon, with a fake CLI standing in
 * for claude (the phase prompt's own "fake CLIs" wording -- one fake CLI
 * here, since the fixture project's team defaults every role to
 * `cli: "claude"`; nothing about this flow is CLI-specific, and adding
 * codex/agy/copilot fakes just to prove the *same* dispatch code path
 * again wouldn't exercise anything new).
 *
 * **Does not reach `integrate`** -- confirmed not a shortcut, a real,
 * disclosed gap already found in milestone 5: `integrate`/
 * `cleanup_worktree` approvals only fire when `p.worktree && p.branch`
 * are both set (`drive.ts`), and `TaskRunner.buildParams()` never sets
 * either for an app-owned task (no worktree mode exists for one today).
 * After the commit approval resolves, the loop finishes straight to
 * `"done"` -- there is no integrate step to reach without this milestone
 * inventing worktree support it doesn't own. */
test("create -> scope -> lineup -> run -> commit approval, through the real UI", async ({ page }) => {
  await goto(page, `/projects/${fixture.projectId}`, true);
  await expect(page.getByRole("button", { name: /new task/i })).toBeVisible();

  // 1. Create.
  await page.getByRole("button", { name: /new task/i }).click();
  await page.getByPlaceholder(/describe what needs to be done/i).fill("Add a reverse function");
  await page.getByRole("button", { name: /create & scope/i }).click();
  await expect(page).toHaveURL(/\/tasks\/.+\/scoping/);

  // 2. Scope: a real two-turn conversation with the fake lead, ending in
  // a real parsed draft spec.
  await expect(page.getByText(/^Scoping:/)).toBeVisible();
  await page.getByPlaceholder(/e\.g\. sonnet/i).fill("m");
  await page.getByRole("button", { name: /start scoping/i }).click();
  await expect(page.getByText("What should the function do exactly?")).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder(/reply to the lead/i).fill("It should reverse a string.");
  await page.getByRole("button", { name: /^send$/i }).click();
  // The spec editor's own <li> specifically -- the raw JSON reply also
  // echoes into the chat transcript above it (a plain <div>), so a bare
  // text match resolves to both.
  await expect(page.locator("li", { hasText: VALID_SPEC.acceptance_criteria[0]! })).toBeVisible({ timeout: 15_000 });

  // 3. Finalize the spec -> hands off to the lineup step.
  await page.getByRole("button", { name: /confirm spec/i }).click();
  await expect(page).toHaveURL(/\/tasks\/.+\/lineup/);

  // 4. Lineup: team defaults already seed every role with a non-empty
  // model ("cheap", an unresolved tier -- there's no team.json yet for
  // this fresh project), so "Confirm and start" is already enabled with
  // no edits needed. What actually matters for this test is that the
  // submitted CLI is "claude" (the fake override), which is also
  // already the default.
  await expect(page.getByRole("button", { name: /confirm and start/i })).toBeEnabled();
  await page.getByRole("button", { name: /confirm and start/i }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/, { timeout: 10_000 });

  // 5. Watch the real fix round run -- the phase moves to
  // "awaiting_commit" once the real developer/gate/verification pipeline
  // finishes and the loop pauses on the commit approval (driveTask() is
  // still genuinely mid-loop here, blocked inside that await -- `active`
  // stays true the whole time this page shows "awaiting_commit", so
  // Cancel, not Resume, is the control visible; this test doesn't
  // exercise cancelling mid-approval, task-control.test.ts already
  // covers cancel/resume/retry-run directly).
  await expect(page.getByText(/awaiting_commit/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^cancel$/i })).toBeVisible();

  // 6. Resolve the real commit approval from the global inbox.
  await page.getByRole("button", { name: /approvals need you/i }).click();
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Commit", exact: true }).click();

  // 7. The real, actual outcome: phase reaches "done", not "awaiting_commit".
  await expect(page.getByText(/^done$/)).toBeVisible({ timeout: 15_000 });
});
