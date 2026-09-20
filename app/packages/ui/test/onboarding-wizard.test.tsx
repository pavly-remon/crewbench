import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard } from "../src/routes/onboarding-wizard.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const DOCTOR_ONE_INSTALLED = {
  reports: [
    { cli: "claude", installed: true, version: "1", config_dir: null, config_dir_writable: null, network_ok: true, network_detail: null, logged_in: true, auth_detail: null, ok: true, errors: [] },
  ],
  checked_at: "2026-01-01T00:00:00Z",
};

function renderWizard() {
  const rootRoute = createRootRoute({ component: OnboardingWizard });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("OnboardingWizard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("plugin install requires a real second confirm click before the request fires", async () => {
    let installCalled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/doctor")) return jsonResponse(DOCTOR_ONE_INSTALLED);
      if (url.includes("/api/plugin-install/claude") && init?.method === "POST") {
        installCalled = true;
        return jsonResponse({ cli: "claude", ok: true, steps: [{ command: "x", ok: true, output: "" }], error: null });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWizard();
    await screen.findByText(/install the plugin/i);
    await waitFor(() => expect(screen.getByRole("button", { name: /^install plugin$/i })).toBeInTheDocument());

    // First click: only shows the confirm row, does not fire the install.
    fireEvent.click(screen.getByRole("button", { name: /^install plugin$/i }));
    expect(installCalled).toBe(false);
    expect(screen.getByText(/install crewbench into claude\?/i)).toBeInTheDocument();

    // Second click (the real confirm button): now it fires.
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(installCalled).toBe(true));
    await waitFor(() => expect(screen.getByText(/plugin installed/i)).toBeInTheDocument());
  });

  it("cancel on the confirm row backs out without ever calling install", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/doctor")) return jsonResponse(DOCTOR_ONE_INSTALLED);
      if (url.includes("/api/plugin-install/")) throw new Error("install should never be called");
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWizard();
    await waitFor(() => expect(screen.getByRole("button", { name: /^install plugin$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^install plugin$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByRole("button", { name: /^install plugin$/i })).toBeInTheDocument();
  });

  it("a real failed install reports the step's own error, not a generic message", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/doctor")) return jsonResponse(DOCTOR_ONE_INSTALLED);
      if (url.includes("/api/plugin-install/claude") && init?.method === "POST") {
        return jsonResponse({
          cli: "claude",
          ok: false,
          steps: [{ command: "claude plugin marketplace add x", ok: false, output: "network unreachable" }],
          error: "adding the marketplace failed",
        });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWizard();
    await waitFor(() => expect(screen.getByRole("button", { name: /^install plugin$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^install plugin$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(screen.getByText(/adding the marketplace failed/i)).toBeInTheDocument());
  });
});
