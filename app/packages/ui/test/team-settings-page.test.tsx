import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamSettingsPage } from "../src/routes/team-settings-page.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderTeamPage() {
  const rootRoute = createRootRoute({ component: TeamSettingsPage });
  const child = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/team", component: TeamSettingsPage });
  const tree = rootRoute.addChildren([child]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ["/projects/p1/team"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("TeamSettingsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a diff preview only after an edit, and saves the full roster on save", async () => {
    let putBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/doctor")) return jsonResponse({ reports: [], checked_at: "2026-01-01T00:00:00Z" });
      if (url.includes("/api/projects/p1/team") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return jsonResponse(putBody);
      }
      if (url.includes("/api/projects/p1/team")) return jsonResponse({ roles: { developer: { cli: "claude", model: "sonnet", effort: "medium", permissions: "safe" } } });
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderTeamPage();
    await screen.findByText(/^Team$/);

    const saveButton = await screen.findByRole("button", { name: /save team defaults/i });
    expect(saveButton).toBeDisabled(); // no edits yet -- nothing to save
    expect(screen.queryByText(/^Changes$/)).not.toBeInTheDocument();

    const modelInputs = screen.getAllByDisplayValue("sonnet");
    fireEvent.change(modelInputs[0] as HTMLInputElement, { target: { value: "opus" } });

    expect(screen.getByText(/^Changes$/)).toBeInTheDocument();
    expect(screen.getByText(/developer\.model: sonnet -> opus/)).toBeInTheDocument();
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { roles: { developer: { model: string } } };
    expect(body.roles.developer.model).toBe("opus");
  });
});
