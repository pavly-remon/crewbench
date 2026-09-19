import { render, screen, waitFor } from "@testing-library/react";
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
    vi.unstubAllGlobals();
  });

  it("renders a card per registered project with its active/recent counts", async () => {
    renderProjectsPage();
    await waitFor(() => expect(screen.getByText("demo")).toBeInTheDocument());
    expect(screen.getByText("/repos/demo")).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("5 recent")).toBeInTheDocument();
  });

  it("shows an empty state when no projects are registered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    renderProjectsPage();
    await waitFor(() => expect(screen.getByText(/no projects registered yet/i)).toBeInTheDocument());
  });
});
