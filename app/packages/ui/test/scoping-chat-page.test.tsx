import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopingChatPage } from "../src/routes/scoping-chat-page.js";

const VALID_SPEC = {
  title: "Fix login redirect",
  description: "Redirects to the wrong page after login.",
  acceptance_criteria: ["Redirects to /dashboard"],
  affected_areas: ["auth"],
  out_of_scope: [],
  needs_design: false,
  constraints: [],
};

function sseResponse(frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200 });
}

function renderScopingPage(taskId = "t1", text = "Fix the login redirect bug") {
  const rootRoute = createRootRoute({ component: ScopingChatPage });
  const child = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks/$taskId/scoping",
    validateSearch: (search: Record<string, unknown>): { text: string } => ({
      text: typeof search.text === "string" ? search.text : "",
    }),
    component: ScopingChatPage,
  });
  const tree = rootRoute.addChildren([child]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [`/tasks/${taskId}/scoping?text=${encodeURIComponent(text)}`] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ScopingChatPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends the first message with the chosen cli/model, streams the reply, and shows the draft spec", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/scoping/messages")) {
        const body = JSON.parse(String(init?.body)) as { message: string; cli?: string; model?: string };
        expect(body.cli).toBe("claude");
        expect(body.model).toBe("m1");
        expect(body.message).toBe("Fix the login redirect bug");
        return sseResponse([
          { type: "chunk", text: "says: thinking about it" },
          { type: "done", ok: true, error: null, reply: "Here is the plan", session_id: "s1", spec: VALID_SPEC },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderScopingPage();

    await screen.findByText(/Scoping: Fix the login redirect bug/i);
    const modelInput = screen.getByPlaceholderText("e.g. sonnet");
    fireEvent.change(modelInput, { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: /start scoping/i }));

    await waitFor(() => expect(screen.getByText("Fix login redirect")).toBeInTheDocument());
    expect(screen.getByText("Redirects to /dashboard")).toBeInTheDocument();
    expect(screen.getByText("Fix the login redirect bug")).toBeInTheDocument(); // the user's own first message, echoed in the transcript
  });

  it("resyncs the editable criteria list when a follow-up turn revises the draft spec", async () => {
    const REVISED_SPEC = { ...VALID_SPEC, acceptance_criteria: ["Redirects to /dashboard", "Shows a success toast"] };
    let turn = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/scoping/messages")) {
        turn += 1;
        const spec = turn === 1 ? VALID_SPEC : REVISED_SPEC;
        void init;
        return sseResponse([{ type: "done", ok: true, error: null, reply: "ok", session_id: "s1", spec }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderScopingPage();

    await screen.findByText(/Scoping: Fix the login redirect bug/i);
    fireEvent.change(screen.getByPlaceholderText("e.g. sonnet"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: /start scoping/i }));
    await waitFor(() => expect(screen.getByText("Redirects to /dashboard")).toBeInTheDocument());
    expect(screen.queryByText("Shows a success toast")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Reply to the lead…"), { target: { value: "also show a toast" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(screen.getByText("Shows a success toast")).toBeInTheDocument());
    expect(screen.getByText("Redirects to /dashboard")).toBeInTheDocument();
  });

  it("doesn't leave the chat stuck 'sending' when the very first turn's request fails outright (no SSE stream ever opens)", async () => {
    const fetchMock = vi.fn(async () => new Response("internal error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    renderScopingPage();

    await screen.findByText(/Scoping: Fix the login redirect bug/i);
    fireEvent.change(screen.getByPlaceholderText("e.g. sonnet"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: /start scoping/i }));

    // Once `openEventStream()` sees the 500 and calls `onDone`, `sending`
    // must flip back to false -- otherwise the follow-up input stays
    // disabled forever with no way to retry.
    await waitFor(() => expect(screen.getByPlaceholderText("Reply to the lead…")).not.toBeDisabled());
  });
});
