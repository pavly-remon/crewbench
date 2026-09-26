import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/routes/settings-page.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderSettingsPage() {
  const rootRoute = createRootRoute({ component: SettingsPage });
  const child = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
  const tree = rootRoute.addChildren([child]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ["/settings"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function baseFetchMock(config: Record<string, unknown>, onPut: (body: unknown) => void) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/doctor")) return jsonResponse({ reports: [], checked_at: "2026-01-01T00:00:00Z" });
    if (url.includes("/api/models/")) return jsonResponse({ cli: "claude", checked: false, available: [], error: null });
    if (url.endsWith("/api/config") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      onPut(body);
      return jsonResponse(body);
    }
    if (url.endsWith("/api/config")) return jsonResponse(config);
    throw new Error(`unexpected fetch: ${url} ${init?.method}`);
  });
}

describe("SettingsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("seeds fields from GET /api/config and saves the edited port on save", async () => {
    let putBody: unknown = null;
    vi.stubGlobal("fetch", baseFetchMock({ port: 4287, notifications: false, theme: "system" }, (b) => (putBody = b)));

    renderSettingsPage();
    await screen.findByText(/^Settings$/);

    const portInput = await screen.findByDisplayValue("4287");
    fireEvent.change(portInput, { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { port: number }).port).toBe(5000);
  });

  it("round-trips notifications and theme", async () => {
    let putBody: unknown = null;
    vi.stubGlobal("fetch", baseFetchMock({}, (b) => (putBody = b)));

    renderSettingsPage();
    await screen.findByText(/^Settings$/);

    fireEvent.click(await screen.findByLabelText(/desktop notifications on by default/i));
    fireEvent.change(screen.getByLabelText(/^theme$/i), { target: { value: "dark" } });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { notifications: boolean; theme: string };
    expect(body.notifications).toBe(true);
    expect(body.theme).toBe("dark");
  });

  it("saves a per-CLI concurrency limit typed into the settings form", async () => {
    let putBody: unknown = null;
    vi.stubGlobal("fetch", baseFetchMock({}, (b) => (putBody = b)));

    renderSettingsPage();
    await screen.findByText(/^Settings$/);

    fireEvent.change(await screen.findByLabelText(/^claude$/i), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { concurrency: Record<string, number> };
    expect(body.concurrency.claude).toBe(3);
  });

  it("seeds the default-lineup editor from config.default_lineup", async () => {
    vi.stubGlobal(
      "fetch",
      baseFetchMock(
        { default_lineup: { developer: { cli: "codex", model: "o1", effort: "medium", permissions: "safe" } } },
        () => {},
      ),
    );

    renderSettingsPage();
    await screen.findByText(/^Settings$/);
    await waitFor(() => expect(screen.getByDisplayValue("o1")).toBeInTheDocument());
  });
});
