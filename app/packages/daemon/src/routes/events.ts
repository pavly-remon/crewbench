import type { FastifyInstance } from "fastify";
import type { CrewbenchEvent } from "@crewbench/contract";
import type { DaemonWatcher, GlobalEvent } from "../watcher.js";
import { startSse, writeSseEvent } from "../sse.js";

function parseLastEventId(header: string | string[] | undefined): number {
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = value ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `GET /api/tasks/:tid/events` -- per-task SSE, replay-then-live. On
 * connect: replays every event on disk with `seq` greater than the
 * client's `Last-Event-ID` (0, i.e. everything, if the header is absent
 * -- see `DaemonWatcher.replayTaskEvents`'s docstring for why a fresh
 * connection gets full history, not just events from now on), then
 * streams new events live as the watcher observes them. Subscribes to
 * the live feed *before* reading the replay snapshot and buffers what
 * arrives during that window, so an event landing exactly at connect
 * time is never dropped (a gap) or sent twice (a duplicate) -- the two
 * failure modes the milestone's own test suite checks for. */
export function registerEventRoutes(app: FastifyInstance, watcher: DaemonWatcher): void {
  app.get<{ Params: { tid: string } }>("/api/tasks/:tid/events", async (request, reply) => {
    const { tid } = request.params;
    if (!watcher.resolveTask(tid)) {
      await reply.code(404).send({ error: `no such task: ${tid}` });
      return;
    }

    const sinceSeq = parseLastEventId(request.headers["last-event-id"]);
    let lastSentSeq = sinceSeq;
    const pending: CrewbenchEvent[] = [];
    let buffering = true;

    const onLive = (taskId: string, event: CrewbenchEvent) => {
      if (taskId !== tid) return;
      if (buffering) pending.push(event);
      else if (event.seq > lastSentSeq) {
        writeSseEvent(reply, String(event.seq), event);
        lastSentSeq = event.seq;
      }
    };
    watcher.on("task-event", onLive);

    const sse = startSse(reply);
    const replayed = await watcher.replayTaskEvents(tid, sinceSeq);
    for (const event of replayed) {
      if (event.seq <= lastSentSeq) continue;
      writeSseEvent(reply, String(event.seq), event);
      lastSentSeq = event.seq;
    }
    buffering = false;
    for (const event of pending) {
      if (event.seq > lastSentSeq) {
        writeSseEvent(reply, String(event.seq), event);
        lastSentSeq = event.seq;
      }
    }

    request.raw.on("close", () => {
      sse.close();
      watcher.off("task-event", onLive);
    });
  });

  /** `GET /api/events` -- the global, cross-project, task-level feed for
   * the board (Phase 2 milestone 3's live task board). In-memory only
   * (see `DaemonWatcher.getGlobalEventsSince`'s docstring): a reconnect
   * with `Last-Event-ID` replays whatever this daemon process has
   * observed since it started, not full cross-project history -- the
   * board's own initial paint comes from the REST listing endpoints
   * (Phase 2 milestone 1), not from this stream. */
  app.get("/api/events", async (request, reply) => {
    const lastId = (() => {
      const header = request.headers["last-event-id"];
      return Array.isArray(header) ? (header[0] ?? null) : (header ?? null);
    })();

    const pending: GlobalEvent[] = [];
    let buffering = true;
    const sentIds = new Set<string>();

    const onGlobal = (event: GlobalEvent) => {
      if (buffering) pending.push(event);
      else if (!sentIds.has(event.id)) {
        writeSseEvent(reply, event.id, event);
        sentIds.add(event.id);
      }
    };
    watcher.on("global-event", onGlobal);

    const sse = startSse(reply);
    const replayed = watcher.getGlobalEventsSince(lastId);
    for (const event of replayed) {
      writeSseEvent(reply, event.id, event);
      sentIds.add(event.id);
    }
    buffering = false;
    for (const event of pending) {
      if (sentIds.has(event.id)) continue;
      writeSseEvent(reply, event.id, event);
      sentIds.add(event.id);
    }

    request.raw.on("close", () => {
      sse.close();
      watcher.off("global-event", onGlobal);
    });
  });
}
