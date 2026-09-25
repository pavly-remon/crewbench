import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskBoardPage } from "../src/routes/task-board-page.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderBoard() {
  const rootRoute = createRootRoute();
  const child = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId", component: TaskBoardPage });
  const tree = rootRoute.addChildren([child]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ["/projects/p1"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("TaskBoardPage's cleanup dialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists cleanup candidates only once opened, and deletes one on explicit per-task confirmation", async () => {
    let deleteCalled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/events")) return new Response("", { status: 200 });
      if (url.endsWith("/api/projects/p1/tasks") && (!init || init.method === undefined)) return jsonResponse([]);
      if (url.includes("/cleanup-candidates")) {
        return jsonResponse([
          { id: "t1", title: "Old finished task", phase: "done", age_days: 45 },
        ]);
      }
      if (url.endsWith("/api/tasks/t1/delete") && init?.method === "POST") {
        deleteCalled = true;
        return jsonResponse({ deleted: "t1" });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderBoard();
    await screen.findByRole("button", { name: /new task/i });

    // Not fetched yet -- the dialog's own query is gated on `open`,
    // mirroring FolderBrowserDialog's own established fix for a mounted-
    // but-closed dialog still firing its query.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("cleanup-candidates"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /clean up old tasks/i }));
    await screen.findByText("Old finished task");
    expect(screen.getByText(/45 days old/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() => expect(deleteCalled).toBe(true));
    await screen.findByText(/deleted old finished task/i);
  });

  it("shows an empty state when nothing is old enough to clean up", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/events")) return new Response("", { status: 200 });
      if (url.endsWith("/api/projects/p1/tasks")) return jsonResponse([]);
      if (url.includes("/cleanup-candidates")) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderBoard();
    await screen.findByRole("button", { name: /new task/i });
    fireEvent.click(screen.getByRole("button", { name: /clean up old tasks/i }));
    await screen.findByText(/no finished tasks are that old yet/i);
  });
});
