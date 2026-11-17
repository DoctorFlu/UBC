import "server-only";

import type { ConsoleSnapshot } from "@/lib/live/types";

import { consoleRoute, sessionIdOf } from "./session";

const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events: the current snapshot at once, then a new one after every change. A comment line
 * every 15 s keeps proxies from closing an idle stream. The browser's EventSource reconnects on its own
 * after one second and gets a full snapshot again, so nothing is lost across a reconnect.
 *
 * A stream is of the session's mandate and hears only that mandate's snapshots, and lives no longer than
 * its session: it ends at once when the session signs out, and at the next snapshot or heartbeat when the
 * session expired or ended any other way, so a stream opened with a stolen cookie stops with it. The
 * browser's reconnect then gets 401, and the page goes to sign in (docs/accounts.md).
 */
export const eventStream = consoleRoute((request, service, { mandate }) => {
  const encoder = new TextEncoder();
  const sessionId = sessionIdOf(request, service.config.accounts);
  const live = () => service.accounts.access(sessionId) !== null;
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
        if (!live()) {
          cleanup();
          return;
        }
        write(`id: ${String(snapshot.seq)}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      };

      write("retry: 1000\n\n");
      send(service.snapshot(mandate));
      const unsubscribe = service.subscribe(mandate, send);
      const heartbeat = setInterval(() => {
        if (live()) write(": keep-alive\n\n");
        else cleanup();
      }, HEARTBEAT_MS);
      const unwatch = service.accounts.onSessionClosed(() => {
        if (!live()) cleanup();
      });
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        unwatch();
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
