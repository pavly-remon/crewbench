import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LineupStepPage } from "../src/routes/lineup-step-page.js";

const TASK_DETAIL = {
  id: "t1",
  project_id: "p1",
  title: "Fix login redirect",
  phase: "scoping",
  round: 0,
  branch: null,
  worktree: null,
  base_commit: null,
  jira_key: null,
  notes: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  stuck_reason: null,
  lineup: {},
  rounds: [],
  issues: [],
  usage: {},
  spec: { title: "Fix login redirect", description: "x", acceptance_criteria: ["y"], affected_areas: [], out_of_scope: [], needs_design: false, constraints: [] },
  warnings: [],
  owner: "app",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderLineupPage() {
  const rootRoute = createRootRoute({ component: LineupStepPage });
  const child = createRoute({ getParentRoute: () => rootRoute, path: "/tasks/$taskId/lineup", component: LineupStepPage });
  const tree = rootRoute.addChildren([child]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ["/tasks/t1/lineup"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("LineupStepPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("seeds all four roles from team defaults, resolves a tier to a real model, and submits on confirm", async () => {
    let submittedBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tasks/t1") && (!init || init.method === undefined)) return jsonResponse(TASK_DETAIL);
      if (url.includes("/api/projects/p1/team")) {
        return jsonResponse({
          roles: { developer: { cli: "codex", model: "strong" } },
          tiers: { codex: { strong: "o1" } },
        });
      }
      if (url.includes("/api/doctor")) return jsonResponse({ reports: [{ cli: "codex", installed: true, version: "1", config_dir: null, config_dir_writable: null, network_ok: true, network_detail: null, logged_in: true, auth_detail: null, ok: true, errors: [] }], checked_at: "2026-01-01T00:00:00Z" });
      if (url.includes("/api/tasks/t1/lineup") && init?.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return jsonResponse({ ...TASK_DETAIL, lineup: (submittedBody as { roles: unknown }).roles });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLineupPage();

    await screen.findByText(/Lineup: Fix login redirect/i);
    // The developer role's model should have resolved codex's "strong"
    // tier to the real model name from team.json's own tiers mapping,
    // not left as the literal string "strong".
    await waitFor(() => expect(screen.getAllByDisplayValue("o1").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: /confirm and start/i }));

    await waitFor(() => expect(submittedBody).not.toBeNull());
    const body = submittedBody as { roles: Record<string, { cli: string; model: string }> };
    expect(Object.keys(body.roles)).toEqual(["developer", "tester", "code-reviewer", "ui-ux"]);
    expect(body.roles.developer).toMatchObject({ cli: "codex", model: "o1" });
  });

  it("shows an inline warning when a role's permissions are set to skip", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tasks/t1")) return jsonResponse(TASK_DETAIL);
      if (url.includes("/api/projects/p1/team")) return jsonResponse({});
      if (url.includes("/api/doctor")) return jsonResponse({ reports: [], checked_at: "2026-01-01T00:00:00Z" });
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLineupPage();
    await screen.findByText(/Lineup: Fix login redirect/i);

    expect(screen.queryByText(/bypasses this role's own permission prompts/i)).not.toBeInTheDocument();
    const permissionSelects = screen.getAllByDisplayValue("safe");
    fireEvent.change(permissionSelects[0] as HTMLSelectElement, { target: { value: "skip" } });
    expect(screen.getByText(/bypasses this role's own permission prompts/i)).toBeInTheDocument();
  });
});
