import { describe, expect, it } from "vitest";
import { AutoResolveForbiddenError, NEVER_AUTO_RESOLVABLE, requestApproval, resolveApproval } from "../src/approvals.js";

describe("approvals", () => {
  it("commit and push are the only never-auto-resolvable kinds", () => {
    expect(NEVER_AUTO_RESOLVABLE).toEqual(new Set(["commit", "push"]));
  });

  it("a normal human decision resolves any kind, including commit/push", () => {
    const req = requestApproval("commit", { message: "fix: x" });
    const resolved = resolveApproval(req, { decision: "yes" });
    expect(resolved.decision).toEqual({ decision: "yes" });
  });

  it("auto=true throws for commit, no matter the decision", () => {
    const req = requestApproval("commit", {});
    expect(() => resolveApproval(req, { decision: "yes" }, { auto: true })).toThrow(AutoResolveForbiddenError);
    expect(() => resolveApproval(req, { decision: "no" }, { auto: true })).toThrow(AutoResolveForbiddenError);
  });

  it("auto=true throws for push", () => {
    const req = requestApproval("push", {});
    expect(() => resolveApproval(req, { decision: "yes" }, { auto: true })).toThrow(AutoResolveForbiddenError);
  });

  it("auto=true is fine for every other kind", () => {
    const req = requestApproval("lineup", {});
    expect(() => resolveApproval(req, { decision: "yes" }, { auto: true })).not.toThrow();
  });

  it("each requested approval gets a unique id", () => {
    const a = requestApproval("design", {});
    const b = requestApproval("design", {});
    expect(a.id).not.toBe(b.id);
  });
});
