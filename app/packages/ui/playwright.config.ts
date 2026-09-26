import { defineConfig } from "@playwright/test";

/** No `webServer` entry -- the fixture daemon (`e2e/global-setup.ts`)
 * already serves this package's built UI itself (the exact same
 * `crewbench ui` code path a real user hits, per
 * `packages/daemon/src/static-ui.ts`), so there's nothing else to boot.
 * Requires `pnpm --filter @crewbench/ui build` to have already run (the
 * daemon has nothing to serve otherwise) -- not run automatically here,
 * matching how the rest of this workspace's `pnpm -r build` already
 * orchestrates build order. */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  use: {
    headless: true,
  },
});
