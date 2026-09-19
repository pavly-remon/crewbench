import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitChanges, gitState } from "../src/git.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-git-"));
  await runGit(dir, "init", "-q");
  await runGit(dir, "config", "user.email", "test@example.com");
  await runGit(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "a.txt"), "hello\n");
  await runGit(dir, "add", "a.txt");
  await runGit(dir, "commit", "-q", "-m", "init");
  return dir;
}

// Ported from tests/test_git_safety.py.
describe("gitState + gitChanges", () => {
  it("a commit moves HEAD and warns, no notes", async () => {
    const repo = await gitRepo();
    const before = await gitState(repo);
    await writeFile(join(repo, "b.txt"), "new\n");
    await runGit(repo, "add", "b.txt");
    await runGit(repo, "commit", "-q", "-m", "second");
    const after = await gitState(repo);
    const { warnings, notes } = gitChanges("developer", before, after);
    expect(warnings.some((w) => w.includes("moved HEAD"))).toBe(true);
    expect(notes).toEqual([]);
  });

  it("flags a stash", async () => {
    const repo = await gitRepo();
    await writeFile(join(repo, "a.txt"), "dirty\n");
    const before = await gitState(repo);
    await runGit(repo, "stash");
    const after = await gitState(repo);
    const { warnings } = gitChanges("developer", before, after);
    expect(warnings.some((w) => w.includes("stash"))).toBe(true);
  });

  it("`checkout -- <file>` reverts a dirty file and warns", async () => {
    const repo = await gitRepo();
    await writeFile(join(repo, "a.txt"), "developer's uncommitted work\n");
    const before = await gitState(repo);
    await runGit(repo, "checkout", "--", "a.txt");
    const after = await gitState(repo);
    const { warnings } = gitChanges("developer", before, after);
    expect(warnings.some((w) => w.includes("reverted or deleted uncommitted changes in: a.txt"))).toBe(true);
  });

  it("`reset --hard` reverts a dirty file and warns", async () => {
    const repo = await gitRepo();
    await writeFile(join(repo, "a.txt"), "developer's uncommitted work\n");
    const before = await gitState(repo);
    await runGit(repo, "reset", "--hard", "HEAD");
    const after = await gitState(repo);
    const { warnings } = gitChanges("developer", before, after);
    expect(warnings.some((w) => w.includes("reverted or deleted uncommitted changes in: a.txt"))).toBe(true);
  });

  it("a fetch-only remote change is a note, not a warning", async () => {
    const repo = await gitRepo();
    const remoteDir = await mkdtemp(join(tmpdir(), "crewbench-remote-"));
    await execFileAsync("git", ["init", "-q", "--bare", remoteDir]);
    await runGit(repo, "remote", "add", "origin", remoteDir);
    await runGit(repo, "push", "-q", "-u", "origin", "HEAD:main");

    const otherDir = await mkdtemp(join(tmpdir(), "crewbench-other-"));
    await execFileAsync("git", ["clone", "-q", remoteDir, otherDir]);
    await runGit(otherDir, "checkout", "-B", "main", "origin/main");
    await writeFile(join(otherDir, "elsewhere.txt"), "from someone else\n");
    await runGit(otherDir, "add", "elsewhere.txt");
    await runGit(otherDir, "-c", "user.email=x@x.com", "-c", "user.name=x", "commit", "-q", "-m", "elsewhere");
    await runGit(otherDir, "push", "-q", "origin", "HEAD:main");

    const before = await gitState(repo);
    await runGit(repo, "fetch", "origin");
    const after = await gitState(repo);
    const { warnings, notes } = gitChanges("developer", before, after);
    expect(warnings.some((w) => w.toLowerCase().includes("push"))).toBe(false);
    expect(notes.some((n) => n.includes("fetch"))).toBe(true);
  });

  it("a push is detected and warned", async () => {
    const repo = await gitRepo();
    const remoteDir = await mkdtemp(join(tmpdir(), "crewbench-remote-"));
    await execFileAsync("git", ["init", "-q", "--bare", remoteDir]);
    await runGit(repo, "remote", "add", "origin", remoteDir);
    await runGit(repo, "push", "-q", "-u", "origin", "HEAD:main");

    const before = await gitState(repo);
    await writeFile(join(repo, "d.txt"), "x\n");
    await runGit(repo, "add", "d.txt");
    await runGit(repo, "commit", "-q", "-m", "d");
    await runGit(repo, "push", "-q", "origin", "HEAD:main");
    const after = await gitState(repo);
    const { warnings } = gitChanges("developer", before, after);
    expect(warnings.some((w) => w.includes("pushed"))).toBe(true);
  });

  it("code-reviewer: any change warns (read-only)", async () => {
    const repo = await gitRepo();
    const before = await gitState(repo);
    await writeFile(join(repo, "a.txt"), "reviewer touched this\n");
    const after = await gitState(repo);
    const { warnings } = gitChanges("code-reviewer", before, after);
    expect(warnings.some((w) => w.includes("read-only"))).toBe(true);
  });

  it("tester: a non-test file warns", async () => {
    const repo = await gitRepo();
    const before = await gitState(repo);
    await writeFile(join(repo, "app.py"), "x = 1\n");
    const after = await gitState(repo);
    const { warnings } = gitChanges("tester", before, after);
    expect(warnings.some((w) => w.includes("non-test files") && w.includes("app.py"))).toBe(true);
  });

  it("tester: a test file does not warn", async () => {
    const repo = await gitRepo();
    const before = await gitState(repo);
    await writeFile(join(repo, "app.test.js"), "test('x', () => {})\n");
    const after = await gitState(repo);
    const { warnings } = gitChanges("tester", before, after);
    expect(warnings.some((w) => w.includes("non-test files"))).toBe(false);
  });

  it("no changes, no warnings", async () => {
    const repo = await gitRepo();
    const before = await gitState(repo);
    const after = await gitState(repo);
    const { warnings, notes } = gitChanges("developer", before, after);
    expect(warnings).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("outside a git repo returns null / an empty result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewbench-notgit-"));
    expect(await gitState(dir)).toBeNull();
    expect(gitChanges("developer", null, null)).toEqual({ warnings: [], notes: [] });
  });
});
