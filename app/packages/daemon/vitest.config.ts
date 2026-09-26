import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Every test file here starts its own real chokidar-backed daemon.
    // Running multiple test *files* in parallel (vitest's default) means
    // several independent chokidar/fsevents watcher instances spin up at
    // once, which on macOS was observed to sometimes cause a freshly
    // created watcher to never deliver its first "add" event at all
    // within a generous timeout, not just deliver it late -- reproduced
    // repeatedly by running this suite standalone several times in a
    // row, isolated from any other workspace package's own test load.
    // Serializing test *files* (tests within one file still run in
    // sequence already, via beforeEach/afterEach) removes the concurrent
    // fsevents churn; the trade is a slightly slower run for a
    // correctness guarantee this suite depends on.
    fileParallelism: false,
  },
});
