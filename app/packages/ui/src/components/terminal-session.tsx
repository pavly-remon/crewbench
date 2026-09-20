import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Dialog } from "./dialog.js";
import { ptyWebSocketUrl } from "../lib/api.js";

interface ServerMessage {
  type: "output" | "exit";
  data?: string;
  code?: number;
}

/** The embedded terminal (Phase 4 milestone 3, Design decision 3) -- a
 * real xterm.js instance wired to the daemon's own PTY WebSocket channel
 * (`routes/pty.ts`). Mounted only while `open` (the dialog unmounts it on
 * close, which also lets the `useEffect` below's own cleanup close the
 * real socket and dispose the real terminal instance -- no session stays
 * open in the background after the dialog closes). */
export function TerminalSessionDialog({ open, onOpenChange, taskId }: { open: boolean; onOpenChange: (open: boolean) => void; taskId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");

  useEffect(() => {
    if (!open || !containerRef.current) return;
    setStatus("connecting");

    const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const ws = new WebSocket(ptyWebSocketUrl(taskId));

    ws.onopen = () => {
      setStatus("open");
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "output" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "exit") {
        term.writeln(`\r\n\x1b[2m[session ended, exit code ${msg.code}]\x1b[0m`);
        setStatus("closed");
      }
    };
    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      // A close before the socket ever reached "open" means the server's
      // own preHandler refused the upgrade (Design decision 3's server-
      // side guard, `routes/pty.ts` -- the task became active, finished,
      // or was removed between this dialog opening and the connection
      // attempt). A browser's own `WebSocket` deliberately exposes no
      // detail about a rejected handshake (no status code, no body,
      // per the WHATWG spec -- confirmed before relying on this, not
      // assumed; this is why `routes/pty.ts`'s own daemon-level test
      // uses the `ws` npm client instead, which *does* see the real
      // HTTP status), so this can only show a generic explanation, not
      // the real server-side reason.
      setStatus((prev) => (prev === "connecting" ? "error" : prev === "open" ? "closed" : prev));
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      ws.close();
      term.dispose();
    };
  }, [open, taskId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Session" widthClassName="max-w-3xl">
      <div className="flex flex-col gap-2">
        {status === "connecting" && <p className="text-xs text-[var(--color-fg-muted)]">Connecting…</p>}
        {status === "error" && (
          <p className="text-xs text-red-500">Couldn't open a session. The task may have changed state since this dialog opened.</p>
        )}
        <div ref={containerRef} className="h-[60vh] w-full overflow-hidden rounded-md bg-black p-1" />
      </div>
    </Dialog>
  );
}
