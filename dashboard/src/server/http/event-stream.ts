import "server-only";

import type { ConsoleSnapshot } from "@/lib/live/types";

import { consoleRoute } from "./session";

const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events: the current snapshot at once, then a new one after every change. A comment line
 * every 15 s keeps proxies from closing an idle stream. The browser's EventSource reconnects on its own
 * after one second and gets a full snapshot again, so nothing is lost across a reconnect.
 *
 * A stream is of the session's mandate and hears only that mandate's snapshots. It is checked once, when
 * it opens: signing out closes nothing that is already open, which the browser does on its own by
 * leaving the page (docs/accounts.md).
 */
export const eventStream = consoleRoute((request, service, { mandate }) => {
  const encoder = new TextEncoder();
  let cleanup = (): void => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (snapshot: ConsoleSnapshot) => {
        write(`id: ${String(snapshot.seq)}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      };

      write("retry: 1000\n\n");
      send(service.snapshot(mandate));
      const unsubscribe = service.subscribe(mandate, send);
      const heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      request.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Compression and proxy buffering both hold events back; neither may touch this stream.
      "Content-Encoding": "none",
      "X-Accel-Buffering": "no",
    },
  });
});
