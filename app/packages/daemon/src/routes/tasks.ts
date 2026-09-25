import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiDiffSchema, ApiRunLogSchema, ApiTaskDetailSchema } from "@crewbench/contract";
import { loadState } from "@crewbench/engine";
import type { DaemonWatcher } from "../watcher.js";
import { buildTaskDetail } from "../task-detail.js";
import type { TaskRunner } from "../task-runner.js";
import { computeDiff } from "../diff.js";

const MAX_LOG_READ_BYTES = 1_000_000;

/** The real, exhaustive set of run-name shapes this codebase ever
 * generates (`runner.ts`'s own `runName()`: `${role}-r${round}` for
 * `developer`/`tester`/`code-reviewer`/`ui-ux`, plus `gate.ts`'s own
 * `gate-r${round}` -- confirmed by reading both, not assumed). A real,
 * disclosed path-traversal gap Copilot review caught: `request.params.run`
 * used to be interpolated straight into a filesystem path with no
 * validation at all -- a value like `../../../../etc/passwd%00` (or any
 * `..`-laden segment) could make `join(taskDir, "runs", ...)` resolve
 * outside the task's own `runs/` directory, and since the path always
 * gets a real `.log` suffix appended, the exposure was "read any
 * `.log`-suffixed file this daemon process can see," not literally
 * arbitrary files -- still a real, unacceptable gap. Rejecting anything
 * that doesn't match this exact shape closes it outright, rather than
 * trying to sanitize or resolve-and-check the resulting path (simpler,
 * and this route only ever needs to serve real run logs anyway). */
const RUN_NAME_RE = /^(developer|tester|code-reviewer|ui-ux|gate)-r\d+$/;

/** Content types this route will actually serve -- a screenshot is
 * always one of these per the tester schema's own `screenshots[]` field
 * (Playwright visual checks save PNG/JPEG); anything else is refused
 * rather than guessed. */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function registerTaskRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner): void {
  app.get<{ Params: { tid: string } }>("/api/tasks/:tid", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const detail = await buildTaskDetail(location, taskRunner);
    await reply.send(ApiTaskDetailSchema.parse(detail));
  });

  /** `GET /api/tasks/:tid/runs/:run/log?from=offset` -- incremental read
   * of one run's `.log` file, the same byte-offset contract
   * `packages/daemon`'s own event tailer uses (`tail.ts`), reused here
   * for a plain still-growing text file instead of a line-delimited
   * event log. Capped at `MAX_LOG_READ_BYTES` per call so a client that
   * falls far behind (or passes `from=0` on a huge log) can't force one
   * response to buffer an unbounded amount of text in memory -- it gets
   * a `next_offset` short of the file's real end and is expected to poll
   * again. */
  app.get<{ Params: { tid: string; run: string }; Querystring: { from?: string } }>(
    "/api/tasks/:tid/runs/:run/log",
    async (request, reply) => {
      const location = watcher.resolveTask(request.params.tid);
      if (!location) {
        await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
        return;
      }
      if (!RUN_NAME_RE.test(request.params.run)) {
        await reply.code(400).send({ error: `malformed run: ${request.params.run}` });
        return;
      }
      const logPath = join(location.taskDir, "runs", `${request.params.run}.log`);
      if (!existsSync(logPath)) {
        await reply.code(404).send({ error: `no such run: ${request.params.run}` });
        return;
      }
      const from = Number(request.query.from ?? "0");
      const start = Number.isFinite(from) && from >= 0 ? from : 0;

      const handle = await open(logPath, "r");
      try {
        const stat = await handle.stat();
        if (stat.size <= start) {
          await reply.send(ApiRunLogSchema.parse({ text: "", next_offset: start }));
          return;
        }
        const length = Math.min(stat.size - start, MAX_LOG_READ_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        await reply.send(ApiRunLogSchema.parse({ text: buffer.toString("utf-8"), next_offset: start + length }));
      } finally {
        await handle.close();
      }
    },
  );

  /** `GET /api/tasks/:tid/diff?round=N|base` -- see `computeDiff()`'s and
   * `ApiDiffSchema`'s docstrings for the real, disclosed limitation that
   * `round=N` and `round=base` currently return the identical diff (no
   * round-scoped git snapshot exists to compute a true delta from). */
  app.get<{ Params: { tid: string }; Querystring: { round?: string } }>("/api/tasks/:tid/diff", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    const raw = request.query.round;
    const round = raw && raw !== "base" ? Number(raw) : null;
    const mode = round === null ? "base" : "round";
    const diff = await computeDiff(location, state, round);
    await reply.send(ApiDiffSchema.parse({ mode, round, diff }));
  });

  /** `GET /api/tasks/:tid/screenshots/:file` -- serves one visual-check
   * image from `.crewbench/tasks/<task-id>/screenshots/`, the exact path
   * a tester result's own `screenshots[]` entries point into (see
   * `schemas/tester.json`'s field description). `basename()` on the
   * param strips any path segments before joining, so `../../etc/passwd`
   * -style traversal resolves to a single (nonexistent) filename inside
   * the screenshots directory rather than escaping it. */
  app.get<{ Params: { tid: string; file: string } }>("/api/tasks/:tid/screenshots/:file", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const file = basename(request.params.file);
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const contentType = IMAGE_CONTENT_TYPES[ext];
    if (!contentType) {
      await reply.code(400).send({ error: "unsupported screenshot file type" });
      return;
    }
    const filePath = join(location.taskDir, "screenshots", file);
    if (!existsSync(filePath)) {
      await reply.code(404).send({ error: `no such screenshot: ${file}` });
      return;
    }
    const handle = await open(filePath, "r");
    try {
      const buffer = await handle.readFile();
      await reply.header("Content-Type", contentType).send(buffer);
    } finally {
      await handle.close();
    }
  });
}
