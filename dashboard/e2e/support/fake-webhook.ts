/**
 * A local stand-in for a Grok Bot routine's webhook, for the end-to-end tests: it answers 200 to a POST
 * with the right path and bearer key, 401 to anything else, and keeps every request. No real webhook
 * is ever called.
 */
import { type Server, createServer } from "node:http";

export interface ReceivedWake {
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

export interface FakeWebhook {
  /** The routine's "POST to" URL; its path stands for the secret some products put there. */
  url: string;
  key: string;
  received: ReceivedWake[];
  stop: () => Promise<void>;
}

export async function startFakeWebhook(port: number): Promise<FakeWebhook> {
  const path = "/routines/e2e-secret-path-4f1c/webhook";
  const key = "e2e-routine-webhook-key-local-only";
  const received: ReceivedWake[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      received.push({
        path: request.url ?? "",
        authorization: request.headers.authorization ?? null,
        contentType: request.headers["content-type"] ?? null,
        body,
      });
      const ok =
        request.method === "POST" &&
        request.url === path &&
        request.headers.authorization === `Bearer ${key}`;
      response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port.toString()}${path}`,
    key,
    received,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
