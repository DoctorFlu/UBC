/**
 * The console's API without Next.js, for the red team's console attacks (redteam/src/console.ts): every
 * route module under `src/app/api` served by plain Node on one port, on a fresh data folder seeded with
 * two workspaces. TEST ONLY: it serves no pages, and it prints the two members' session cookies.
 *
 * Run it from the dashboard folder, so tsx reads this folder's tsconfig for the `@/` alias:
 *
 *   tsx --import ./scripts/server-only.mjs scripts/redteam-console.ts
 *
 * with CONSOLE_URL=http://127.0.0.1:<port>, CONSOLE_DATA_DIR (a new, empty folder) and
 * CONSOLE_SERVICE_TOKEN. Alice claims the first workspace (the server's own mandate, with 0.4242 BTC of
 * holdings) and Bob signs up for his own; each gets a first agent token. When it listens, it prints one
 * JSON line to stdout:
 * `{"ready":true,"alice":{"cookie","workspaceId","mandateId","agentId","token","tokenId"},"bob":{...}}`.
 * Logs go to stderr.
 */
import { readdirSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimFirstWorkspace,
  sessionHeader,
  signUpWorkspace,
  workspaceAgent,
} from "../test/support/accounts";
import type { Member } from "../src/server/accounts/store";
import { getConsoleService } from "../src/server/console";

/** Alice's holdings: a quantity nobody else has, so a leak is easy to find. */
export const ALICE_HOLDING = { asset: "BTC", quantity: "0.4242" } as const;

type Params = Record<string, string>;
type Handler = (request: Request, context: { params: Promise<Params> }) => Promise<Response> | Response;

interface Route {
  path: string;
  pattern: RegExp;
  names: string[];
  dynamic: number;
  methods: Record<string, Handler>;
}

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "api");

/** Every `route.ts` under `src/app/api`, as the App Router maps it: `[name]` is one path segment. */
export async function loadApiRoutes(apiDir = API_DIR): Promise<Route[]> {
  const files = (readdirSync(apiDir, { recursive: true }) as string[]).filter(
    (file) => file === "route.ts" || file.endsWith(`${sep}route.ts`),
  );
  const routes: Route[] = [];
  for (const file of files) {
    const segments = [
      "api",
      ...dirname(file)
        .split(sep)
        .filter((s) => s !== "." && s !== ""),
    ];
    const names: string[] = [];
    const source = segments
      .map((segment) => {
        const param = /^\[([A-Za-z]+)\]$/.exec(segment);
        if (param?.[1] === undefined) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(param[1]);
        return "([^/]+)";
      })
      .join("/");
    const routeModule = (await import(join(apiDir, file))) as Record<string, unknown>;
    const methods: Record<string, Handler> = {};
    for (const method of METHODS) {
      const handler = routeModule[method];
      if (typeof handler === "function") methods[method] = handler as Handler;
    }
    routes.push({
      path: `/${segments.join("/")}`,
      pattern: new RegExp(`^/${source}$`),
      names,
      dynamic: names.length,
      methods,
    });
  }
  // A fixed segment wins over a parameter, as in Next.js.
  return routes.sort((a, b) => a.dynamic - b.dynamic);
}

function match(routes: Route[], pathname: string): { route: Route; params: Params } | null {
  for (const route of routes) {
    const found = route.pattern.exec(pathname);
    if (found === null) continue;
    const params: Params = {};
    route.names.forEach((name, i) => {
      params[name] = decodeURIComponent(found[i + 1] ?? "");
    });
    return { route, params };
  }
  return null;
}

async function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }
  const method = req.method ?? "GET";
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body =
    method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks);
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    signal,
    ...(body === undefined ? {} : { body }),
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (response.body !== null) {
    // An event stream ends when the client goes away: the request's signal tells the handler.
    for await (const chunk of response.body) {
      if (res.destroyed) break;
      res.write(chunk);
    }
  }
  res.end();
}

function json(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: { code, message } }));
}

/**
 * A member's ids, session and first agent token. The token is made here, as the member's passkey would
 * have confirmed it (#95: creating a token takes a passkey, which the red team's HTTP client has none of).
 */
function seeded(member: Member) {
  const service = getConsoleService();
  const { agent, mandate } = workspaceAgent(service, member);
  const { token, view } = service.accounts.store.createToken(agent.id, "Grok (red team)");
  return {
    cookie: sessionHeader(service, member),
    workspaceId: member.workspaceId,
    mandateId: mandate.id,
    agentId: agent.id,
    token,
    tokenId: view.id,
  };
}

async function main(): Promise<void> {
  const consoleUrl = new URL(process.env.CONSOLE_URL ?? "");
  const port = Number(consoleUrl.port);
  if (consoleUrl.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1) {
    throw new Error("set CONSOLE_URL to http://127.0.0.1:<port>");
  }
  if (!process.env.CONSOLE_DATA_DIR?.trim()) throw new Error("set CONSOLE_DATA_DIR to a new, empty folder");
  const routes = await loadApiRoutes();
  const service = getConsoleService();
  if (service.accounts.store.firstWorkspace().claimedAt !== null) {
    throw new Error("the data folder already has a claimed workspace; give it a new, empty one");
  }
  const alice = claimFirstWorkspace(service, "Alice");
  const bob = signUpWorkspace(service, "Bob");
  service.offchain.saveHoldings(service.accounts.store.envMandate().id, [ALICE_HOLDING]);

  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      controller.abort();
    });
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", consoleUrl.origin).pathname;
        const found = match(routes, pathname);
        if (found === null) {
          json(res, 404, "not_found", "No route.");
          return;
        }
        const handler = found.route.methods[req.method ?? "GET"];
        if (handler === undefined) {
          json(res, 405, "method_not_allowed", "Method not allowed.");
          return;
        }
        const request = await toRequest(req, consoleUrl.origin, controller.signal);
        await send(res, await handler(request, { params: Promise.resolve(found.params) }));
      } catch (error) {
        if (controller.signal.aborted) return;
        process.stderr.write(`redteam-console: ${error instanceof Error ? error.message : String(error)}\n`);
        if (!res.headersSent) json(res, 500, "internal", "The console failed.");
        else res.end();
      }
    })();
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`${JSON.stringify({ ready: true, alice: seeded(alice), bob: seeded(bob) })}\n`);
  });
  const stop = () => {
    server.close();
    server.closeAllConnections();
    void service.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`redteam-console: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
