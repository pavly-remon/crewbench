import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "../src/components/update-banner.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function renderBanner() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UpdateBanner />
    </QueryClientProvider>,
  );
}

describe("UpdateBanner", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders nothing when no update is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ current: "1.0.0", latest: "1.0.0", update_available: false, error: null, checked_at: "2026-01-01T00:00:00Z" })),
    );
    renderBanner();
    await waitFor(() => expect(screen.queryByText(/is available/i)).not.toBeInTheDocument());
  });

  it("renders nothing when current couldn't be determined, even if update_available were somehow true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ current: null, latest: "9.9.9", update_available: false, error: null, checked_at: "2026-01-01T00:00:00Z" })),
    );
    renderBanner();
    await waitFor(() => expect(screen.queryByText(/is available/i)).not.toBeInTheDocument());
  });

  it("shows the real current/latest versions when an update is available, and can be dismissed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ current: "1.0.0", latest: "1.2.0", update_available: true, error: null, checked_at: "2026-01-01T00:00:00Z" })),
    );
    renderBanner();
    await screen.findByText(/1\.2\.0 is available/i);
    expect(screen.getByText(/you have 1\.0\.0/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/is available/i)).not.toBeInTheDocument();
  });

  it("stays dismissed for the same version across a remount, but not for a later version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ current: "1.0.0", latest: "1.2.0", update_available: true, error: null, checked_at: "2026-01-01T00:00:00Z" })),
    );
    const { unmount } = renderBanner();
    await screen.findByText(/1\.2\.0 is available/i);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    unmount();

    renderBanner();
    await waitFor(() => expect(screen.queryByText(/is available/i)).not.toBeInTheDocument());
  });
});
