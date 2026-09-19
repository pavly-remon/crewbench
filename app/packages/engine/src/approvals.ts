/** Ported from docs/app/phase-1-plan.md's milestone 5 scope and
 * docs/app/CONTEXT.md's non-negotiable principle 3: "Commit and push are
 * always explicit human approvals. No flag, setting or automation can
 * skip them." This module is the enforced backstop for that rule -- see
 * resolveApproval()'s hard-coded rejection of an auto-resolve attempt on
 * `commit`/`push`, which no caller (CLI flag, `--yes`, a saved team.json
 * setting) can route around. */
export const APPROVAL_KINDS = [
  "confirm_profile",
  "lineup",
  "design",
  "dirty_tree",
  "worktree_setup",
  "commit",
  "push",
  "integrate",
  "cleanup_worktree",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Kinds that can never be resolved without a real, explicit human
 * decision -- see resolveApproval(). */
export const NEVER_AUTO_RESOLVABLE: ReadonlySet<ApprovalKind> = new Set(["commit", "push"]);

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  payload: unknown;
  requestedAt: string;
}

export type ApprovalDecision =
  | { decision: "yes"; data?: unknown }
  | { decision: "no"; data?: unknown }
  | { decision: "custom"; data: unknown }; // e.g. integrate's merge/cherry-pick/leave/nothing choice

export interface ResolvedApproval {
  id: string;
  kind: ApprovalKind;
  decision: ApprovalDecision;
  resolvedAt: string;
}

let approvalCounter = 0;

export function requestApproval(kind: ApprovalKind, payload: unknown, now: () => string = () => new Date().toISOString()): ApprovalRequest {
  approvalCounter += 1;
  return { id: `approval-${approvalCounter}`, kind, payload, requestedAt: now() };
}

export class AutoResolveForbiddenError extends Error {
  constructor(kind: ApprovalKind) {
    super(
      `${kind} can never be auto-resolved -- no flag, setting or automation may skip this approval ` +
        "(docs/app/CONTEXT.md's non-negotiable principle 3). A real human decision is required.",
    );
    this.name = "AutoResolveForbiddenError";
  }
}

/** Resolves a pending approval with a human's decision. `auto` marks a
 * resolution path driven by something *other* than a live, this-instant
 * human answer (a `--yes` flag, `confirm_lineup: never`, a saved
 * team.json default, a batch/non-interactive mode) -- passing `auto: true`
 * for `commit`/`push` always throws, regardless of what `decision` was
 * given, since no such path is ever legitimate for those two kinds. Every
 * other kind may be auto-resolved (that's what `--yes` and
 * `confirm_lineup` are for). */
export function resolveApproval(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  options: { auto?: boolean } = {},
  now: () => string = () => new Date().toISOString(),
): ResolvedApproval {
  if (options.auto && NEVER_AUTO_RESOLVABLE.has(request.kind)) {
    throw new AutoResolveForbiddenError(request.kind);
  }
  return { id: request.id, kind: request.kind, decision, resolvedAt: now() };
}
