import type { FastifyInstance } from "fastify";
import { loadState } from "@crewbench/engine";
import { ApiPendingApprovalSchema, ApiResolveApprovalRequestSchema } from "@crewbench/contract";
import type { DaemonWatcher } from "../watcher.js";
import type { TaskRunner } from "../task-runner.js";

/** `GET /api/approvals`, `POST /api/tasks/:tid/approvals/:aid` (Phase 3
 * milestone 5). Every pending approval this daemon knows about lives
 * purely in-memory, inside the `HttpApprovalProvider` of whichever
 * task's `driveTask()` loop is currently blocked on it
 * (`TaskRunner.listAllPendingApprovals()`, wired up here for the first
 * time) -- there is no on-disk "pending approvals" file to read instead.
 * **No `GET /api/tasks/:tid/approvals`**: an earlier draft of this
 * milestone added one for symmetry with the global listing, but nothing
 * in the UI calls it (only the global inbox is wired up) -- dropped in
 * human review rather than shipped as unused surface; re-add if a real
 * caller needs it (`TaskRunner.listPendingApprovals(taskId)`, built in
 * milestone 1, is still there to build it on). A daemon restart doesn't
 * lose the underlying *task*
 * state (its `state.json` phase still says it's waiting, and
 * `reattachProject()` picks it back up, re-reaching the same
 * `askApproval()` call and producing a fresh pending approval with a new
 * id), just this daemon process's specific in-flight request for it.
 *
 * **Only `commit`/`integrate`/`cleanup_worktree` are ever actually
 * issued today** -- `packages/engine/src/drive.ts`'s `askApproval()` is
 * the only caller of `requestApproval()` anywhere in this codebase
 * (confirmed by grep, not assumed), and it's called for exactly those
 * three kinds. `ApprovalKind` also lists `confirm_profile`, `lineup`,
 * `design`, `dirty_tree`, `worktree_setup`, `push`: the first two are
 * real UI flows in this app, just not built on the approvals system at
 * all (Phase 3 milestone 4's profile/lineup pages); `design` is decided
 * by a plain `confirm()` in `commands/run.ts` outside `driveTask()`
 * entirely; `dirty_tree`/`worktree_setup` are CLI-terminal worktree
 * pre-flight steps that happen *before* `driveTask()` is ever called
 * (see `drive.ts`'s own `DriveTaskLineup` docstring, Phase 3 milestone
 * 1) and, for an app-owned task specifically, never happen at all today
 * -- `TaskRunner.buildParams()` never creates a worktree, so `worktree`/
 * `branch` are always unset for a daemon-driven task unless something
 * writes them onto `state.json` directly (nothing does, yet); `push`
 * has no implementation anywhere in this codebase at all -- no git push
 * call exists in `worktree.ts` today, `integrate` only merges/
 * cherry-picks locally onto the original branch. This route resolves
 * *any* kind generically (it has no kind-specific logic of its own,
 * `driveTask()`'s own `askApproval()` call sites decide what a
 * decision means), so it's already correct for all nine kinds the
 * moment a future milestone makes more of them real -- not a limitation
 * of this route, a limitation of what currently calls it. */
export function registerApprovalRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner): void {
  app.get("/api/approvals", async (_request, reply) => {
    const rows = taskRunner.listAllPendingApprovals();
    const enriched = await Promise.all(
      rows.map(async ({ taskId, request }) => {
        const location = watcher.resolveTask(taskId);
        if (!location) return null; // the task was deregistered between listing and enrichment -- skip, don't 500 the whole inbox
        const state = await loadState(location.taskDir).catch(() => null);
        if (!state) return null;
        return {
          task_id: taskId,
          project_id: location.projectId,
          title: state.title,
          id: request.id,
          kind: request.kind,
          payload: request.payload,
          requested_at: request.requestedAt,
        };
      }),
    );
    await reply.send(ApiPendingApprovalSchema.array().parse(enriched.filter((row) => row !== null)));
  });

  app.post<{ Params: { tid: string; aid: string }; Body: unknown }>("/api/tasks/:tid/approvals/:aid", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const parsed = ApiResolveApprovalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const resolved = taskRunner.resolveApproval(request.params.tid, request.params.aid, parsed.data);
    if (!resolved) {
      await reply.code(404).send({ error: `no pending approval ${request.params.aid} on task ${request.params.tid}` });
      return;
    }
    await reply.send({ ok: true });
  });
}
