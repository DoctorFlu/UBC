import "server-only";

import type { ConsoleSnapshot } from "@/lib/live/types";

import type { ConsoleService } from "../console-service";

const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events: the current snapshot at once, then a new one after every change. A comment line
 * every 15 s keeps proxies from closing an idle stream. The browser's EventSource reconnects on its own
 * after one second and gets a full snapshot again, so nothing is lost across a reconnect.
 */
export function eventStream(request: Request, service: ConsoleService): Response {
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
      send(service.snapshot());
      const unsubscribe = service.subscribe(send);
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
}
