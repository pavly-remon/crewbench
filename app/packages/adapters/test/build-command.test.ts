import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCommand } from "../src/build-command.js";
import { checkArgvSize } from "../src/argv.js";
import type { BuildCommandArgs } from "../src/types.js";
import type { RoleName } from "@crewbench/contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(__dirname, "..", "..", "..", "..", "schemas");
const CLIS = ["claude", "agy", "codex", "copilot"] as const;
const ROLES: RoleName[] = ["developer", "tester", "code-reviewer", "ui-ux"];

function makeArgs(overrides: Partial<BuildCommandArgs> & Pick<BuildCommandArgs, "role" | "cli">): BuildCommandArgs {
  return {
    model: "m",
    effort: "medium",
    skipPermissions: false,
    cwd: "/tmp/project",
    timeoutS: 1800,
    ...overrides,
  };
}

// Ported from tests/test_build_command.py's test_build_command_shape.
describe("buildCommand", () => {
  for (const cli of CLIS) {
    for (const role of ROLES) {
      for (const skip of [false, true]) {
        it(`${cli} / ${role} / skip=${skip}`, () => {
          const args = makeArgs({ role, cli, skipPermissions: skip });
          const schemaPath = join(SCHEMAS_DIR, `${role}.json`);
          const tmp = mkdtempSync(join(tmpdir(), "crewbench-bc-"));
          const promptFile = join(tmp, "run.prompt.md");
          const { argv, stdin } = buildCommand(args, "FULL PROMPT ".repeat(5000), promptFile, schemaPath, tmp);

          expect(argv[0]).toBe(cli);
          expect(() => checkArgvSize(argv)).not.toThrow();

          if (cli === "agy") {
            expect(argv).toContain(args.cwd); // --add-dir <cwd>
          }

          if (cli === "claude" || cli === "codex") {
            expect(stdin).not.toBeNull();
            expect(stdin).toContain("FULL PROMPT");
          } else {
            expect(stdin).toBeNull();
            const joined = argv.join(" ");
            expect(joined).not.toContain("FULL PROMPT");
            expect(joined).toContain(promptFile);
          }

          if (role === "code-reviewer") {
            expect(argv).not.toContain("--dangerously-skip-permissions");
            expect(argv).not.toContain("danger-full-access");
            expect(argv).not.toContain("bypassPermissions");
            expect(argv).not.toContain("--allow-all-tools");
          } else if (skip) {
            if (cli === "claude") expect(argv).toContain("bypassPermissions");
            if (cli === "agy") expect(argv).toContain("--dangerously-skip-permissions");
            if (cli === "codex") expect(argv).toContain("danger-full-access");
            if (cli === "copilot") expect(argv).toContain("--allow-all-tools");
          }

          if (cli === "copilot") {
            expect(argv).toContain("--usage-output-file");
          }
          if (cli === "codex") {
            expect(argv).toContain("--json");
          }
        });
      }
    }
  }

  it("throws for an oversized prompt-pointer argument (agy)", () => {
    const args = makeArgs({ role: "developer", cli: "agy" });
    const schemaPath = join(SCHEMAS_DIR, "developer.json");
    const tmp = mkdtempSync(join(tmpdir(), "crewbench-bc-"));
    const hugePath = "x".repeat(100_001);
    const { argv } = buildCommand(args, "prompt", hugePath, schemaPath, tmp);
    expect(() => checkArgvSize(argv)).toThrow();
  });

  it("codex writes a strict schema to tmp and points there, never at the canonical file", () => {
    const args = makeArgs({ role: "code-reviewer", cli: "codex" });
    const schemaPath = join(SCHEMAS_DIR, "code-reviewer.json");
    const tmp = mkdtempSync(join(tmpdir(), "crewbench-bc-"));
    const { argv, extraOutputFile } = buildCommand(args, "prompt text", join(tmp, "p.md"), schemaPath, tmp);
    const idx = argv.indexOf("--output-schema");
    expect(idx).toBeGreaterThan(-1);
    const writtenSchemaPath = argv[idx + 1] as string;
    expect(writtenSchemaPath).not.toBe(schemaPath); // never points at the canonical file
    const written = JSON.parse(readFileSync(writtenSchemaPath, "utf-8"));
    expect(new Set(written.required)).toEqual(new Set(Object.keys(written.properties)));
    expect(extraOutputFile).not.toBeNull();
  });
});
