import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // e2e/ holds Playwright specs (run via `pnpm e2e`, a separate
    // runner/process model) -- vitest's default include glob matches
    // *.spec.ts too, so without this it tries to execute Playwright's
    // own test() inside vitest's runner and fails immediately.
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
