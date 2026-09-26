import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "../src/routes/profile-page.js";

const DETECTED = {
  package_manager: "npm",
  install: "npm ci",
  commands: { lint: "npm run lint", typecheck: null, test: "npm run test", test_changed: null, build: null, format_check: null },
  test_patterns: ["*.test.ts"],
  source_dirs: ["src"],
  languages: ["typescript"],
  frameworks: [],
  agy_allow_rules: [],
  confirmed: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderProfilePage() {
  const rootRoute = createRootRoute({ component: ProfilePage });
  const child = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/profile", component: ProfilePage });
  const tree = rootRoute.addChildren([child]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ["/projects/p1/profile"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ProfilePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows 'no profile yet' on a 404, then refresh/edit/confirm saves a real, edited profile", async () => {
    let putBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?refresh=1")) return jsonResponse(DETECTED);
      if (url.includes("/api/projects/p1/profile") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return jsonResponse(putBody);
      }
      if (url.includes("/api/projects/p1/profile")) return jsonResponse({ error: "no project profile yet" }, 404);
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderProfilePage();

    await screen.findByText(/no project profile yet/i);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await screen.findByDisplayValue("npm ci");
    expect(screen.getByText(/not yet confirmed/i)).toBeInTheDocument();

    const lintInput = screen.getByDisplayValue("npm run lint");
    fireEvent.change(lintInput, { target: { value: "npm run lint:fix" } });

    fireEvent.click(screen.getByRole("button", { name: /confirm and save/i }));
    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { confirmed: boolean; commands: { lint: string } };
    expect(body.confirmed).toBe(true);
    expect(body.commands.lint).toBe("npm run lint:fix");
  });
});
