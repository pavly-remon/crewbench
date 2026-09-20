import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalInbox } from "../src/components/approval-inbox.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const COMMIT_APPROVAL = {
  task_id: "t1",
  project_id: "p1",
  title: "Add a reverse function",
  id: "approval-1",
  kind: "commit",
  payload: { title: "Add a reverse function", diffStat: "1 file changed, 1 insertion(+)" },
  requested_at: "2026-01-01T00:00:00Z",
};

function renderInbox() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApprovalInbox />
    </QueryClientProvider>,
  );
}

describe("ApprovalInbox", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a badge count from GET /api/approvals and opens a panel with one card per pending approval", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/events")) return new Response("", { status: 200 });
      if (url.includes("/api/approvals")) return jsonResponse([COMMIT_APPROVAL]);
      if (url.includes("/diff")) return jsonResponse({ mode: "base", round: null, diff: "" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderInbox();

    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument()); // the badge count

    fireEvent.click(screen.getByRole("button", { name: /1 approvals need you/i }));

    expect(await screen.findByRole("button", { name: /^commit$/i })).toBeInTheDocument();
    expect(screen.getByText("Add a reverse function")).toBeInTheDocument();
    expect(screen.getByText(/1 file changed/)).toBeInTheDocument();
  });

  it("resolving a commit approval POSTs the decision and the card disappears from the panel", async () => {
    let approvals = [COMMIT_APPROVAL];
    let postBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/events")) return new Response("", { status: 200 });
      if (url.includes("/diff")) return jsonResponse({ mode: "base", round: null, diff: "" });
      if (init?.method === "POST" && url.includes("/approvals/approval-1")) {
        postBody = JSON.parse(String(init.body));
        approvals = [];
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/approvals")) return jsonResponse(approvals);
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderInbox();
    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /1 approvals need you/i }));
    await screen.findByRole("button", { name: /^commit$/i });

    fireEvent.click(screen.getByRole("button", { name: /^commit$/i }));

    await waitFor(() => expect(postBody).toEqual({ decision: "yes", data: { message: "Add a reverse function" } }));
    await waitFor(() => expect(screen.getByText(/nothing needs you right now/i)).toBeInTheDocument());
  });

  it("shows a generic card for an approval kind with no bespoke UI", async () => {
    const genericApproval = { ...COMMIT_APPROVAL, id: "approval-2", kind: "confirm_profile", payload: { detected: { language: "typescript" } } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/events")) return new Response("", { status: 200 });
      if (url.includes("/api/approvals")) return jsonResponse([genericApproval]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderInbox();
    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /1 approvals need you/i }));

    expect(await screen.findByText("Confirm project profile")).toBeInTheDocument();
    expect(screen.getByText(/"language": "typescript"/)).toBeInTheDocument();
  });
});
