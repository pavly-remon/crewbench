import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";

const execFileAsync = promisify(execFile);

describe("GET /api/fs/browse", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  it("defaults to the server's own home directory when no path is given", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/fs/browse"), { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(homedir());
  });

  it("lists real subdirectories, excludes dotfiles, and flags a real git repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewbench-daemon-fsbrowse-"));
    await mkdir(join(root, "plain-folder"));
    await mkdir(join(root, ".hidden-folder"));
    const repoDir = join(root, "a-repo");
    await mkdir(repoDir);
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir });

    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url(`/api/fs/browse?path=${encodeURIComponent(root)}`), { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      entries: Array<{ name: string; path: string; is_git_repo: boolean }>;
    };
    expect(body.path).toBe(root);
    expect(body.parent).toBe(dirname(root));
    expect(body.entries).toEqual([
      { name: "a-repo", path: repoDir, is_git_repo: true },
      { name: "plain-folder", path: join(root, "plain-folder"), is_git_repo: false },
    ]);
  });

  it("navigating into a listed entry's own path lists its children in turn -- real breadcrumb navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewbench-daemon-fsbrowse-nav-"));
    const child = join(root, "child");
    const grandchild = join(child, "grandchild");
    await mkdir(grandchild, { recursive: true });

    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url(`/api/fs/browse?path=${encodeURIComponent(child)}`), { headers });
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toEqual(["grandchild"]);
  });

  it("400s with a real error message for a path that doesn't exist", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url(`/api/fs/browse?path=${encodeURIComponent("/no/such/directory/at/all")}`), { headers });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});
