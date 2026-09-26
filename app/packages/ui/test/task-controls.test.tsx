import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiTaskDetail } from "@crewbench/contract";
import { TaskControls, RunLaneRetryButton } from "../src/components/task-controls.js";

function baseDetail(overrides: Partial<ApiTaskDetail> = {}): ApiTaskDetail {
  return {
    id: "t1",
    project_id: "p1",
    title: "Fix login redirect",
    phase: "fixing",
    round: 1,
    branch: null,
    worktree: null,
    base_commit: null,
    jira_key: null,
    notes: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    stuck_reason: null,
    lineup: { developer: { cli: "claude", model: "m", effort: "medium", permissions: "safe" } },
    rounds: [],
    issues: [],
    usage: {},
    spec: null,
    warnings: [],
    owner: "app",
    active: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("TaskControls", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows Cancel (not Resume) for an active task, and POSTs a bodyless cancel", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) return jsonResponse({ pty: false });
      if (url.includes("/cancel") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({});
        return jsonResponse(baseDetail({ active: false, phase: "stopped" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<TaskControls detail={baseDetail({ active: true })} projectPath={undefined} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("shows Resume (not Cancel) for a stopped, inactive task, and calls resume with no body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) return jsonResponse({ pty: false });
      if (url.includes("/resume") && init?.method === "POST") {
        expect(init.body).toBeUndefined();
        expect(new Headers(init.headers).has("Content-Type")).toBe(false);
        return jsonResponse(baseDetail({ active: true, phase: "fixing" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<TaskControls detail={baseDetail({ active: false, phase: "stopped" })} projectPath="/repos/demo" />);
    expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("copies a cd-and-resume one-liner to the clipboard when a project path is known", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ pty: false })),
    );

    renderWithQuery(<TaskControls detail={baseDetail({ active: false, phase: "failed" })} projectPath="/repos/demo" />);
    fireEvent.click(screen.getByRole("button", { name: /copy resume command/i }));

    expect(writeText).toHaveBeenCalledWith("cd /repos/demo && crewbench resume t1");
  });

  it("shows neither Cancel nor Resume for a task that's neither active nor stopped/failed", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ pty: false })),
    );
    renderWithQuery(<TaskControls detail={baseDetail({ active: false, phase: "verifying" })} projectPath={undefined} />);
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy resume command/i })).toBeInTheDocument();
  });

  it("shows 'Open session' alongside Resume when pty capability is available and the task is resumable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/capabilities")) return jsonResponse({ pty: true });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderWithQuery(<TaskControls detail={baseDetail({ active: false, phase: "stopped" })} projectPath={undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /open session/i })).toBeInTheDocument());
  });

  it("does not show 'Open session' when pty capability is unavailable, even for a resumable task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/capabilities")) return jsonResponse({ pty: false });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderWithQuery(<TaskControls detail={baseDetail({ active: false, phase: "stopped" })} projectPath={undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /open session/i })).not.toBeInTheDocument();
  });

  it("does not show 'Open session' for an active task, even when pty capability is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/capabilities")) return jsonResponse({ pty: true });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderWithQuery(<TaskControls detail={baseDetail({ active: true })} projectPath={undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /open session/i })).not.toBeInTheDocument();
  });
});

describe("RunLaneRetryButton", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders for the current round's developer run on an inactive task", () => {
    renderWithQuery(<RunLaneRetryButton taskId="t1" run="developer-r2" detail={baseDetail({ active: false, phase: "stopped", round: 2 })} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders nothing for an earlier round than the task's current one", () => {
    renderWithQuery(<RunLaneRetryButton taskId="t1" run="developer-r1" detail={baseDetail({ active: false, phase: "stopped", round: 2 })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("renders nothing while the task is active", () => {
    renderWithQuery(<RunLaneRetryButton taskId="t1" run="developer-r1" detail={baseDetail({ active: true, round: 1 })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("renders nothing for a run name retry doesn't apply to (ui-ux)", () => {
    renderWithQuery(<RunLaneRetryButton taskId="t1" run="ui-ux" detail={baseDetail({ active: false, phase: "stopped", round: 1 })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});
