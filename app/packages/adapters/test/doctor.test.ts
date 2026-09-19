import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { dirWritable, doctor } from "../src/doctor.js";

// Ported from tests/test_dir_writable.py.
describe("dirWritable", () => {
  it("an existing writable dir is writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewbench-dw-"));
    expect(dirWritable(dir)).toBe(true);
  });

  it("a nonexistent dir with a writable parent is writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewbench-dw-"));
    expect(dirWritable(join(dir, "not-created-yet"))).toBe(true);
  });

  it("a deeply nested nonexistent dir still resolves to a writable ancestor", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewbench-dw-"));
    expect(dirWritable(join(dir, "a", "b", "c"))).toBe(true);
  });

  it.skipIf(platform() === "win32" || process.getuid?.() === 0)(
    "a nonexistent dir under a read-only ancestor is not writable",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "crewbench-dw-"));
      const roParent = join(dir, "read-only-parent");
      mkdirSync(roParent);
      chmodSync(roParent, 0o500);
      try {
        expect(dirWritable(join(roParent, "not-created-yet"))).toBe(false);
      } finally {
        chmodSync(roParent, 0o700);
      }
    },
  );

  it("a file instead of a directory is not writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewbench-dw-"));
    const file = join(dir, "a_file");
    writeFileSync(file, "x");
    expect(dirWritable(file)).toBe(false);
  });
});

// Ported from tests/test_doctor.py, using the same fake_status_cli.py
// fixture the Python suite uses (spawned directly -- see cli-paths.ts's
// cliArgvPrefix()), so both language ports exercise identical behavior.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = resolve(__dirname, "..", "..", "..", "..", "tests", "fixtures", "fake_clis", "fake_status_cli.py");

function listener(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("doctor", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it("reports ok when everything checks out", async () => {
    const { port, close } = await listener();
    try {
      process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = FAKE_CLI;
      process.env.CREWBENCH_NETWORK_CHECK_OVERRIDE_CLAUDE = `127.0.0.1:${port}`;
      const report = await doctor("claude");
      expect(report.ok).toBe(true);
      expect(report.installed).toBe(true);
      expect(report.network_ok).toBe(true);
      expect(report.logged_in).toBe(true);
      expect(report.errors).toEqual([]);
    } finally {
      close();
    }
  });

  it("reports not installed", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CODEX = "";
    process.env.PATH = "/nonexistent";
    const report = await doctor("codex");
    expect(report.ok).toBe(false);
    expect(report.installed).toBe(false);
    expect(report.errors[0]).toContain("not installed");
  });

  it("flags unreachable network", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_AGY = FAKE_CLI;
    process.env.CREWBENCH_NETWORK_CHECK_OVERRIDE_AGY = "127.0.0.1:1";
    const report = await doctor("agy");
    expect(report.ok).toBe(false);
    expect(report.network_ok).toBe(false);
    expect(report.errors.some((e) => e.includes("sandbox blocks network"))).toBe(true);
  });

  it("flags not logged in", async () => {
    const { port, close } = await listener();
    try {
      process.env.CREWBENCH_CLI_OVERRIDE_CODEX = FAKE_CLI;
      process.env.CREWBENCH_NETWORK_CHECK_OVERRIDE_CODEX = `127.0.0.1:${port}`;
      process.env.FAKE_STATUS_FAIL = "not logged in";
      const report = await doctor("codex");
      expect(report.ok).toBe(false);
      expect(report.logged_in).toBe(false);
      expect(report.errors.some((e) => e.includes("does not appear to be logged in"))).toBe(true);
    } finally {
      close();
    }
  });
});
