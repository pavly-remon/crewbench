import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ApiCliSchema, type ApiCli } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { SpecEditor } from "../components/spec-editor.js";
import { useScopingChat, useFinalizeScoping } from "../api/tasks.js";

const CLI_OPTIONS = ApiCliSchema.options;

/** New-task-dialog -> scoping-chat -> spec-editor (Phase 3 milestone 3).
 * The first message is the task text the New task dialog collected
 * (`search.text`, since the task-creation endpoint's own response only
 * carries a truncated `title` -- see `api/tasks.ts`'s `useScopingChat`
 * docstring). `cli`/`model` are only asked for once, before that first
 * message goes out -- every later turn in `useScopingChat` resumes
 * automatically. There is no lineup step to hand off into yet (milestone
 * 4) -- confirming a spec here lands back on the task detail page, which
 * already renders a finalized spec via the existing spec tab. */
export function ScopingChatPage() {
  const { taskId } = useParams({ from: "/tasks/$taskId/scoping" });
  const search = useSearch({ from: "/tasks/$taskId/scoping" });
  const navigate = useNavigate();
  const { messages, draftSpec, sending, error, send } = useScopingChat(taskId);
  const finalize = useFinalizeScoping(taskId);

  const [cli, setCli] = useState<ApiCli>("claude");
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const started = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages]);

  const startScoping = () => {
    if (started.current || !model.trim()) return;
    started.current = true;
    send(search.text, { cli, model: model.trim() });
  };

  const sendFollowUp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    send(input.trim());
    setInput("");
  };

  const onConfirm = (spec: Parameters<typeof finalize.mutate>[0]) => {
    finalize.mutate(spec, {
      onSuccess: () => {
        navigate({ to: "/tasks/$taskId", params: { taskId } }).catch(() => {});
      },
    });
  };

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
      <Card className="flex h-[70vh] flex-col gap-3">
        <h1 className="text-sm font-semibold">Scoping: {search.text}</h1>

        {!started.current && (
          <div className="flex items-end gap-2 rounded-md border border-[var(--color-border)] p-3">
            <label className="flex flex-col gap-1 text-sm">
              Lead CLI
              <select
                value={cli}
                onChange={(e) => setCli(e.target.value as ApiCli)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
              >
                {CLI_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Model
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. sonnet"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
              />
            </label>
            <Button variant="primary" onClick={startScoping} disabled={!model.trim()}>
              Start scoping
            </Button>
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
              <div
                className={
                  "inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap " +
                  (m.role === "user" ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-bg-subtle)]")
                }
              >
                {m.text || "…"}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <form onSubmit={sendFollowUp} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={started.current ? "Reply to the lead…" : "Pick a lead CLI and model to start"}
            disabled={!started.current || sending}
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
          <Button type="submit" variant="secondary" disabled={!started.current || sending || !input.trim()}>
            Send
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">Draft spec</h2>
        {!draftSpec && <p className="text-sm text-[var(--color-fg-muted)]">Not ready yet -- keep the conversation going.</p>}
        {draftSpec && <SpecEditor spec={draftSpec} onConfirm={onConfirm} confirming={finalize.isPending} />}
        {finalize.isError && <p className="mt-2 text-sm text-red-500">{finalize.error.message}</p>}
      </Card>
    </div>
  );
}
