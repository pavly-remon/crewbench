import { afterEach, describe, expect, it } from "vitest";
import { cliArgvPrefix } from "../src/cli-paths.js";

// Ported from tests/test_cli_argv_prefix.py.
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("cliArgvPrefix", () => {
  afterEach(() => {
    delete process.env.CREWBENCH_PYTHON;
  });

  it("passes a real executable through unchanged", () => {
    expect(cliArgvPrefix("/usr/local/bin/claude")).toEqual(["/usr/local/bin/claude"]);
  });

  it("passes a .py override through unchanged on POSIX", () => {
    withPlatform("darwin", () => {
      expect(cliArgvPrefix("/repo/tests/fixtures/fake_clis/quick_success.py")).toEqual([
        "/repo/tests/fixtures/fake_clis/quick_success.py",
      ]);
    });
  });

  it("gets an interpreter prefix for a .py override on Windows", () => {
    // Regression (ported from the Python test suite's own Windows CI
    // finding): a bare .py path can't be launched directly via
    // child_process.spawn without a shell on Windows.
    withPlatform("win32", () => {
      const result = cliArgvPrefix("C:\\repo\\tests\\fixtures\\fake_clis\\quick_success.py");
      expect(result).toEqual(["python", "C:\\repo\\tests\\fixtures\\fake_clis\\quick_success.py"]);
    });
  });

  it("leaves a real Windows .exe unaffected", () => {
    withPlatform("win32", () => {
      expect(cliArgvPrefix("C:\\Program Files\\claude\\claude.exe")).toEqual(["C:\\Program Files\\claude\\claude.exe"]);
    });
  });
});
