import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const BIN = resolve(__dirname, "..", "dist", "bin.js");

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-commit-e2e-"));
  const run = (args: string[]) => new Promise<void>((res, rej) => execFile("git", args, { cwd: dir }, (err) => (err ? rej(err) : res())));
  await run(["init", "-q"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await writeFile(join(dir, "a.txt"), "hello\n");
  await run(["add", "a.txt"]);
  await run(["commit", "-q", "-m", "init"]);
  return dir;
}

/** A fake `claude` that reads the *whole* assembled prompt from stdin
 * (buildPrompt() embeds the role's JSON Schema in every hand-off -- see
 * prompt.ts) and returns a schema-shaped result per role, distinguishing
 * them by a field unique to each role's schema (tester's "tests_run",
 * reviewer's "previous_issues", developer's everything else). This lets
 * one fake CLI stand in for all three roles distinctly and correctly,
 * unlike quick_success.py (always developer-shaped) -- needed here since
 * this test exercises the *approve* path, which the other e2e tests
 * (run.e2e.test.ts, resume.e2e.test.ts) deliberately don't. The same
 * fake CLI is also used for the scoping call; its reply there has no
 * "result"/"response" string field (extractChatReply() only recognizes
 * plain text, not `structured_output`), so runChatTurn() reports
 * ok:false and scoping exits immediately with no spec -- no interactive
 * back-and-forth to script around, deliberately. */
async function fakeClaudeCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-fakecli-commit-"));
  const path = join(dir, "fake-claude.cjs");
  const script = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf-8");
  // Distinguish by a field unique to each role's own schema -- crucially
  // including "files_changed" for the developer branch specifically
  // (not a bare else), since the *scoping* call's prompt matches neither
  // "tests_run" nor "previous_issues" either, and would otherwise fall
  // into a bare else here too. A real finding from Phase 1 milestone 7's
  // end-to-end verification: an earlier version of this fixture used a
  // bare "else" for the developer branch, so the scoping call (which
  // runs with cwd = the *main* repo, before the worktree even exists)
  // also matched it and wrote src/reverse.js into the main tree -- which
  // then collided with the same file arriving via the real commit when
  // merging the worktree's branch back. Not a crewbench bug: purely this
  // fixture's own classification being too loose.
  if (prompt.includes("tests_run")) {
    const result = { verdict: "pass", summary: "all good", tests_run: ["a.test.js"], tests_added: [], failures: [], blocked: [] };
    respond(result);
  } else if (prompt.includes("previous_issues")) {
    const result = { verdict: "approve", summary: "looks good", issues: [], blocked: [] };
    respond(result);
  } else if (prompt.includes("files_changed")) {
    // The developer branch: actually write the file it claims to have
    // written, in its own cwd (the worktree, when workspace.mode is
    // worktree) -- a fake CLI that only *claims* files_changed without
    // touching disk left git commit with nothing to commit, a second
    // real finding from the same verification pass.
    require("fs").mkdirSync("src", { recursive: true });
    require("fs").writeFileSync("src/reverse.js", "module.exports = function reverse(str) { return str.split('').reverse().join(''); };");
    const result = { status: "done", summary: "did the thing", files_changed: ["src/reverse.js"], assumptions: [], questions: [], blocked: [] };
    respond(result);
  } else {
    // Anything else (the scoping call): no structured_output at all --
    // extractChatReply() finds no "result"/"response" string field
    // either, so runChatTurn() reports ok:false and scoping exits
    // immediately with no spec, deliberately (see this file's top note).
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-commit-flow", model: "m" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", permission_denials: [] }));
  }
  function respond(result) {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-commit-flow", model: "m" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", structured_output: result, permission_denials: [] }));
  }
});
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return path;
}

/** Proves the full "accept commit -> merge -> remove worktree" path
 * works together, end to end, through a real subprocess -- the one
 * significant piece of driveTask()'s request_commit_approval branch the
 * other e2e tests (which all use --yes, and --yes always declines commit
 * per the non-negotiable-approval invariant) never exercise. Confirmed
 * live separately, against real CLIs, that --yes correctly *declines*
 * the commit prompt without asking (see docs/compatibility.md's Phase 1
 * milestone 7 notes) -- this test is the accept-path counterpart, using
 * a fake CLI so it doesn't depend on live API access or cost real usage. */
describe("crewbench run: full commit-approval flow (end to end, fake CLI)", () => {
  it("commits, merges onto the original branch, and removes the worktree on explicit yes answers", async () => {
    const repo = await gitRepo();
    const fakeCli = await fakeClaudeCli();
    const env = { ...process.env, CREWBENCH_ROOT: REPO_ROOT, CREWBENCH_CLI_OVERRIDE_CLAUDE: fakeCli };

    // No --yes at all: every prompt is real and answered via piped stdin,
    // in the exact order run.ts/drive.ts asks them for a task with no
    // saved team.json and no design:
    //   1. "Save this as the project profile?"        (default yes) -> y
    //   2. "Proceed with this lineup?"                 (default yes) -> y
    //   3. "Use the ui-ux role for this task?"         (default no)  -> "" (no design)
    //   4. "The main tree has uncommitted changes...   (default no)  -> y
    //      Continue anyway?" (writing project.json in step 1 makes the
    //      main tree dirty before the worktree pre-flight check runs)
    //   5. "Copy .env, .env.local into the worktree?"  (default no)  -> "" (skip)
    //   6. "Commit this work?"                         (default yes) -> y
    //   7. "Commit message [<title>]: "                (free text)   -> "" (use the default)
    //   8. "Bring it back how? [merge/cherry-pick/leave/none]: "      -> merge
    //   9. "Remove the worktree now?"                  (default no)  -> y
    const stdin = ["y", "y", "", "y", "", "y", "", "merge", "y"].join("\n") + "\n";

    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolveResult) => {
      const child = execFile(
        process.execPath,
        [BIN, "run", "Add a function reverse(str) in src/reverse.js", "--rounds", "1"],
        { cwd: repo, env, timeout: 45_000 },
        (err, out) => resolveResult({ stdout: out, code: err && "code" in err ? (err.code as number) : 0 }),
      );
      child.stdin?.write(stdin);
      child.stdin?.end();
    });

    expect(code).toBe(0);
    expect(stdout).toContain("  tester: done");
    expect(stdout).toContain("  code-reviewer: done");
    expect(stdout).toContain("Committed");
    expect(stdout).toContain("Merged onto the original branch");

    const mainLog = await new Promise<string>((res, rej) => {
      execFile("git", ["log", "--oneline", "-3"], { cwd: repo }, (err, out) => (err ? rej(err) : res(out)));
    });
    // The commit message defaulted to the task's title (an empty answer
    // to "Commit message [<title>]: ").
    expect(mainLog.toLowerCase()).toContain("reverse");
  }, 60_000);
});
