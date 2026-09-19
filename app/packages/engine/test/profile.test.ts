import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agyRulesForCommands, detectProfile } from "../src/profile.js";

async function newRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "crewbench-profile-"));
}

// Ported from tests/test_profile.py.
describe("detectProfile", () => {
  it("detects node/npm/jest/eslint", async () => {
    const root = await newRoot();
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "jest", build: "tsc -b" }, devDependencies: { jest: "^29", eslint: "^9" } }),
    );
    await writeFile(join(root, ".eslintrc.json"), "{}");
    const profile = await detectProfile(root);
    expect(profile.package_manager).toBe("npm");
    expect(profile.install).toBe("npm ci");
    expect(profile.commands?.lint).toBe("npm run lint");
    expect(profile.commands?.test).toBe("npm run test");
    expect(profile.frameworks).toContain("jest");
    expect(profile.frameworks).toContain("eslint");
    expect(profile.confirmed).toBe(false);
  });

  it("detects python from requirements.txt alone, no pytest.ini", async () => {
    const root = await newRoot();
    await writeFile(join(root, "requirements.txt"), "flask\n");
    const profile = await detectProfile(root);
    expect(profile.package_manager).toBe("pip");
    expect(profile.install).toBe("pip install -r requirements.txt");
    expect(profile.frameworks).not.toContain("pytest");
  });

  it("detects pytest.ini without a pyproject.toml", async () => {
    const root = await newRoot();
    await writeFile(join(root, "requirements.txt"), "pytest\n");
    await writeFile(join(root, "pytest.ini"), "[pytest]\n");
    const profile = await detectProfile(root);
    expect(profile.frameworks).toContain("pytest");
    expect(profile.commands?.test).toBe("pytest");
  });

  it("detects go", async () => {
    const root = await newRoot();
    await writeFile(join(root, "go.mod"), "module example.com/x\n\ngo 1.22\n");
    const profile = await detectProfile(root);
    expect(profile.languages).toEqual(["go"]);
    expect(profile.commands?.test).toBe("go test ./...");
  });

  it("an empty dir is a valid, confirmed=false shape", async () => {
    const root = await newRoot();
    const profile = await detectProfile(root);
    expect(profile.languages).toEqual([]);
    expect(profile.package_manager).toBeNull();
    expect(profile.commands).toEqual({
      lint: null,
      typecheck: null,
      test: null,
      test_changed: null,
      build: null,
      format_check: null,
    });
  });
});

describe("agyRulesForCommands", () => {
  it("uses the binary+subcommand prefix", () => {
    expect(agyRulesForCommands({ lint: "npm run lint", test: "pytest -q", solo: "go" })).toEqual([
      "command(npm run)",
      "command(pytest -q)",
      "command(go)",
    ]);
  });

  it("skips null commands and dedupes", () => {
    expect(agyRulesForCommands({ lint: "npm run lint", format_check: null, test: "npm run lint" })).toEqual(["command(npm run)"]);
  });
});

// Not in the Python suite (no Makefile detection test there), added to
// cover detectMake() since it was ported here too.
describe("detectMake", () => {
  it("uses a Makefile target when no other command was found", async () => {
    const root = await newRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "Makefile"), "lint:\n\techo lint\n\ntest:\n\techo test\n");
    const profile = await detectProfile(root);
    expect(profile.commands?.lint).toBe("make lint");
    expect(profile.commands?.test).toBe("make test");
  });
});
