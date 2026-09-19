import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project, ProjectCommands } from "@crewbench/contract";

const LOCKFILE_PACKAGE_MANAGERS: Record<string, string> = {
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
};

const INSTALL_COMMANDS: Record<string, string> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --frozen-lockfile",
  bun: "bun install",
};

const RUN_PREFIX: Record<string, string> = { npm: "npm run", pnpm: "pnpm", yarn: "yarn", bun: "bun run" };
const RUN_PREFIX_BIN: Record<string, string> = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" };

/** Mutable working shape while detection accumulates fields -- converted
 * to the (mostly) frozen `Project` contract shape at the end of detect(). */
interface Draft {
  package_manager: string | null;
  install: string | null;
  commands: Required<ProjectCommands>;
  test_patterns: string[];
  source_dirs: string[];
  languages: string[];
  frameworks: string[];
  agy_allow_rules: string[];
  confirmed: boolean;
}

function emptyDraft(): Draft {
  return {
    package_manager: null,
    install: null,
    commands: { lint: null, typecheck: null, test: null, test_changed: null, build: null, format_check: null },
    test_patterns: [],
    source_dirs: [],
    languages: [],
    frameworks: [],
    agy_allow_rules: [],
    confirmed: false,
  };
}

function scriptCommand(scripts: Record<string, unknown>, runPrefix: string, names: string[]): string | null {
  for (const name of names) {
    if (name in scripts) return `${runPrefix} ${name}`;
  }
  return null;
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function detectNode(root: string, draft: Draft): Promise<void> {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return;
  const pkg = ((await readJsonIfExists(pkgPath)) as Record<string, unknown>) ?? {};
  const scripts = (typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {}) as Record<string, unknown>;
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };

  draft.languages.push(existsSync(join(root, "tsconfig.json")) ? "typescript" : "javascript");

  const pm = Object.entries(LOCKFILE_PACKAGE_MANAGERS).find(([file]) => existsSync(join(root, file)))?.[1] ?? null;
  draft.package_manager = pm;
  if (pm) draft.install = INSTALL_COMMANDS[pm] ?? null;
  const run = (pm && RUN_PREFIX[pm]) || "npm run";

  draft.commands.lint = scriptCommand(scripts, run, ["lint"]);
  draft.commands.typecheck = scriptCommand(scripts, run, ["typecheck", "type-check", "tsc"]);
  draft.commands.test = scriptCommand(scripts, run, ["test"]);
  draft.commands.build = scriptCommand(scripts, run, ["build"]);
  draft.commands.format_check = scriptCommand(scripts, run, ["format:check", "format-check"]);

  if ("jest" in deps) {
    draft.frameworks.push("jest");
    draft.commands.test_changed ??= `${run} test -- --changed`;
    draft.test_patterns.push("*.test.js", "*.test.ts", "*.test.jsx", "*.test.tsx");
  }
  if ("vitest" in deps) {
    draft.frameworks.push("vitest");
    draft.commands.test_changed ??= `${run} test -- --changed`;
    draft.test_patterns.push("*.test.js", "*.test.ts", "*.spec.js", "*.spec.ts");
  }
  if (existsSync(join(root, "playwright.config.ts")) || existsSync(join(root, "playwright.config.js"))) {
    draft.frameworks.push("playwright");
    draft.test_patterns.push("*.spec.ts");
  }
  const runBin = (pm && RUN_PREFIX_BIN[pm]) || "npx";
  if (["", ".js", ".json", ".cjs"].some((ext) => existsSync(join(root, `.eslintrc${ext}`))) || existsSync(join(root, "eslint.config.js"))) {
    draft.frameworks.push("eslint");
    draft.commands.lint ??= `${runBin} eslint .`;
  }
  if (["", ".json", ".js"].some((ext) => existsSync(join(root, `.prettierrc${ext}`))) || existsSync(join(root, "prettier.config.js"))) {
    draft.frameworks.push("prettier");
    draft.commands.format_check ??= `${runBin} prettier --check .`;
  }
  if (existsSync(join(root, "biome.json")) || existsSync(join(root, "biome.jsonc"))) {
    draft.frameworks.push("biome");
    draft.commands.lint ??= `${runBin} biome check .`;
  }
}

async function detectPython(root: string, draft: Draft): Promise<void> {
  const hasPyproject = existsSync(join(root, "pyproject.toml"));
  const hasRequirements = readdirSync(root).some((f) => /^requirements.*\.txt$/.test(f));
  if (!hasPyproject && !hasRequirements) return;
  draft.languages.push("python");
  draft.package_manager ??= "pip";
  const pyprojectText = hasPyproject ? await readTextIfExists(join(root, "pyproject.toml")) : "";
  if (hasPyproject) {
    if (pyprojectText.includes("poetry")) {
      draft.package_manager = "poetry";
      draft.install ??= "poetry install";
    } else if (/\[tool\.(uv|pdm)\]/.test(pyprojectText) || pyprojectText.toLowerCase().includes("uv")) {
      draft.package_manager = pyprojectText.includes("[tool.uv]") ? "uv" : draft.package_manager;
    }
  }
  draft.install ??= hasPyproject ? "pip install -e .[dev]" : "pip install -r requirements.txt";
  const hasPytestIni = existsSync(join(root, "pytest.ini")) || existsSync(join(root, "conftest.py"));
  const hasPytestConfig = hasPyproject && pyprojectText.includes("pytest");
  if (hasPytestIni || hasPytestConfig) {
    draft.frameworks.push("pytest");
    draft.commands.test ??= "pytest";
    draft.commands.test_changed ??= "pytest --picked";
    draft.test_patterns.push("test_*.py", "*_test.py");
  }
  if (existsSync(join(root, "ruff.toml")) || existsSync(join(root, ".ruff.toml")) || (hasPyproject && pyprojectText.includes("ruff"))) {
    draft.frameworks.push("ruff");
    draft.commands.lint ??= "ruff check .";
    draft.commands.format_check ??= "ruff format --check .";
  }
  if (existsSync(join(root, "mypy.ini")) || (hasPyproject && pyprojectText.includes("mypy"))) {
    draft.frameworks.push("mypy");
    draft.commands.typecheck ??= "mypy .";
  }
}

function detectGo(root: string, draft: Draft): void {
  if (!existsSync(join(root, "go.mod"))) return;
  draft.languages.push("go");
  draft.package_manager = "go";
  draft.commands.test ??= "go test ./...";
  draft.commands.build ??= "go build ./...";
  if (existsSync(join(root, ".golangci.yml"))) draft.commands.lint ??= "golangci-lint run";
  draft.test_patterns.push("*_test.go");
}

async function detectMake(root: string, draft: Draft): Promise<void> {
  const makefilePath = join(root, "Makefile");
  if (!existsSync(makefilePath)) return;
  const text = await readTextIfExists(makefilePath);
  const targets = new Set([...text.matchAll(/^([a-zA-Z][\w-]*):/gm)].map((m) => m[1] as string));
  const fields: [keyof Draft["commands"], string[]][] = [
    ["lint", ["lint"]],
    ["typecheck", ["typecheck", "type-check"]],
    ["test", ["test"]],
    ["build", ["build"]],
    ["format_check", ["fmt-check", "format-check"]],
  ];
  for (const [field, names] of fields) {
    if (draft.commands[field] === null) {
      const match = names.find((n) => targets.has(n));
      if (match) draft.commands[field] = `make ${match}`;
    }
  }
}

function detectSourceDirs(root: string, draft: Draft): void {
  for (const candidate of ["src", "lib", "app", "cmd", "internal", "pkg"]) {
    if (existsSync(join(root, candidate))) draft.source_dirs.push(candidate);
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/** Detects a project's package manager, commands and conventions for
 * `.crewbench/project.json`. Never writes anything itself -- the caller
 * shows this proposal to the user and only saves it on confirmation (see
 * lib/dispatch.md §0's "Project profile"). Ported field-for-field from
 * crewbench_profile.py's detect(). */
export async function detectProfile(root: string): Promise<Project> {
  const draft = emptyDraft();
  await detectNode(root, draft);
  await detectPython(root, draft);
  detectGo(root, draft);
  await detectMake(root, draft);
  detectSourceDirs(root, draft);
  draft.languages = unique(draft.languages);
  draft.frameworks = unique(draft.frameworks);
  draft.test_patterns = unique(draft.test_patterns);
  draft.agy_allow_rules = agyRulesForCommands(draft.commands);
  // Draft's fields match Project's required shape exactly; the cast is
  // only for Project's `.catchall(z.unknown())` index signature, which a
  // plain object literal type structurally can't satisfy on its own.
  return draft as Project;
}

/** Suggested agy `command(...)` allow rules for a {name: command} map,
 * using agy's real matching semantics (word-by-word prefix -- see
 * @crewbench/adapters' agyCommandRules() for the matching side): each
 * rule is the command's first two words (binary + subcommand) with no
 * trailing `*`, since agy already treats a rule as a prefix. Ported from
 * crewbench_profile.py's agy_rules_for_commands(). */
export function agyRulesForCommands(commands: Record<string, string | null | undefined>): string[] {
  const rules: string[] = [];
  for (const command of Object.values(commands)) {
    if (!command) continue;
    const words = command.split(/\s+/);
    const prefix = words.length > 1 ? words.slice(0, 2).join(" ") : (words[0] as string);
    const rule = `command(${prefix})`;
    if (!rules.includes(rule)) rules.push(rule);
  }
  return rules;
}
