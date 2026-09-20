import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "../src/routes/projects-page.js";
import type { ApiProject } from "@crewbench/contract";

const sampleProjects: ApiProject[] = [
  {
    id: "p1",
    path: "/repos/demo",
    name: "demo",
    added_at: "2026-09-19T10:00:00Z",
    active_task_count: 2,
    recent_task_count: 5,
  },
];

function renderProjectsPage() {
  const rootRoute = createRootRoute({ component: ProjectsPage });
  const child = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId", component: () => null });
  const routeTree = rootRoute.addChildren([child]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sampleProjects), { status: 200 })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a card per registered project with its active/recent counts", async () => {
    renderProjectsPage();
    await waitFor(() => expect(screen.getByText("demo")).toBeInTheDocument());
    expect(screen.getByText("/repos/demo")).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("5 recent")).toBeInTheDocument();
  });

  it("shows the onboarding wizard instead of the project grid when no projects are registered (Phase 4 milestone 2)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes("/api/doctor")) {
        return new Response(
          JSON.stringify({
            reports: [
              { cli: "claude", installed: true, version: "1", config_dir: null, config_dir_writable: null, network_ok: true, network_detail: null, logged_in: true, auth_detail: null, ok: true, errors: [] },
              { cli: "codex", installed: false, version: null, config_dir: null, config_dir_writable: null, network_ok: null, network_detail: null, logged_in: null, auth_detail: null, ok: false, errors: ["not installed"] },
            ],
            checked_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProjectsPage();

    await screen.findByText(/welcome to crewbench/i);
    // Step 1: doctor status for every CLI, both installed and not --
    // "claude" appears twice (step 1's status row, step 3's install
    // offer), "codex" (not installed) only once, in step 1.
    await waitFor(() => expect(screen.getAllByText("claude").length).toBeGreaterThan(0));
    expect(screen.getAllByText("codex")).toHaveLength(1);
    // Step 3: an install-plugin offer only for the CLI doctor reports
    // installed -- not for codex, which isn't.
    expect(screen.getAllByRole("button", { name: /install plugin/i })).toHaveLength(1);
    // No project-grid page heading -- this replaces the whole page, not
    // a banner on top of it.
    expect(screen.queryByRole("heading", { name: /^projects$/i })).not.toBeInTheDocument();
  });

  it("picks a project path through the folder browser, not by typing -- there is no free-text path input at all", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/fs/browse")) {
        if (url.includes("path=")) {
          return new Response(
            JSON.stringify({ path: "/repos/demo", parent: "/repos", entries: [] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            path: "/repos",
            parent: "/",
            entries: [{ name: "demo", path: "/repos/demo", is_git_repo: true }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/projects") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify(sampleProjects), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderProjectsPage();
    await waitFor(() => expect(screen.getByText("demo")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /add project/i }));
    expect(screen.queryByPlaceholderText(/\/path\/to\/repo/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no folder chosen yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^browse…$/i }));
    await screen.findByRole("button", { name: "demo" });
    fireEvent.click(screen.getByRole("button", { name: "demo" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /select this folder/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /select this folder/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("/repos/demo")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^add$/i })).toBeEnabled();
  });
});
