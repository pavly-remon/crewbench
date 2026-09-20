import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiCli, ApiEffort, ApiScopingStreamEvent, ApiTaskDetail, TaskSpec } from "@crewbench/contract";
import { apiFetch, openEventStream } from "../lib/api.js";

export function useCreateTask(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { task_text: string; jira_key?: string | undefined }) =>
      apiFetch<ApiTaskDetail>(`/api/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "tasks"] }).catch(() => {});
    },
  });
}

export function useFinalizeScoping(taskId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: TaskSpec) => apiFetch<ApiTaskDetail>(`/api/tasks/${taskId}/scoping/finalize`, { method: "POST", body: JSON.stringify(spec) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", taskId] }).catch(() => {});
    },
  });
}

export interface ScopingChatMessage {
  role: "user" | "lead";
  text: string;
}

/** Drives one task's scoping conversation (Phase 3 milestone 3): opens a
 * fresh SSE stream per `send()` call (`POST .../scoping/messages`,
 * Design decision 4), appending the lead's reply text live as `chunk`
 * frames arrive, and resolving to a draft spec once a `done` frame's own
 * `spec` is non-null. `cli`/`model`/`effort` are only meaningful (and
 * only sent) on the very first message -- see `routes/scoping.ts`'s own
 * docstring for why every later turn resumes from what the daemon
 * already persisted. */
export function useScopingChat(taskId: string | undefined) {
  const [messages, setMessages] = useState<ScopingChatMessage[]>([]);
  const [draftSpec, setDraftSpec] = useState<TaskSpec | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamingIndex = useRef<number | null>(null);

  const send = useCallback(
    (text: string, opts?: { cli?: ApiCli; model?: string; effort?: ApiEffort }) => {
      if (!taskId || sending) return;
      setSending(true);
      setError(null);
      setMessages((prev) => [...prev, { role: "user", text }]);
      setMessages((prev) => {
        streamingIndex.current = prev.length;
        return [...prev, { role: "lead", text: "" }];
      });

      openEventStream(
        `/api/tasks/${taskId}/scoping/messages`,
        (_id, data) => {
          const event = data as ApiScopingStreamEvent;
          if (event.type === "chunk") {
            setMessages((prev) => {
              const idx = streamingIndex.current;
              if (idx === null) return prev;
              const next = [...prev];
              const current = next[idx];
              if (!current) return prev;
              next[idx] = { ...current, text: current.text ? `${current.text}\n${event.text}` : event.text };
              return next;
            });
          } else if (event.type === "done") {
            setSending(false);
            streamingIndex.current = null;
            if (!event.ok) {
              setError(event.error ?? "scoping turn failed");
            } else if (event.reply) {
              setMessages((prev) => {
                const idx = prev.length - 1;
                const current = prev[idx];
                if (!current || current.role !== "lead") return prev;
                const next = [...prev];
                next[idx] = { ...current, text: event.reply as string };
                return next;
              });
            }
            if (event.spec) setDraftSpec(event.spec as TaskSpec);
          }
        },
        {
          method: "POST",
          body: { message: text, cli: opts?.cli, model: opts?.model, effort: opts?.effort },
          onDone: () => setSending(false),
        },
      );
    },
    [taskId, sending],
  );

  return { messages, draftSpec, sending, error, send };
}
