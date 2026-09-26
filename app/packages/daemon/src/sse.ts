import type { FastifyReply } from "fastify";

const HEARTBEAT_MS = 15_000;

/** Sets SSE response headers and starts a keep-alive heartbeat (a `:`
 * comment line, per the SSE spec -- ignored by `EventSource` but keeps
 * an idle connection from being dropped by a proxy/load balancer sitting
 * in front of it). Returns a `close()` to stop the heartbeat; callers
 * must call it when the client disconnects. */
export function startSse(reply: FastifyReply): { close: () => void } {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const heartbeat = setInterval(() => {
    reply.raw.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  return { close: () => clearInterval(heartbeat) };
}

export function writeSseEvent(reply: FastifyReply, id: string, data: unknown): void {
  reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}
