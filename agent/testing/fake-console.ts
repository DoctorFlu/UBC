/**
 * An in-memory console backend that implements the agent API in `@mandate/shared` `console-api.ts`
 * with the same schemas, for tests and the end-to-end smoke run. It is not production code: the
 * real console lives in `dashboard/`.
 *
 * It behaves like the contract describes: bearer auth (401), schema validation (422 with a
 * `consoleErrorSchema` body), hash verification of decision contexts (422 `hash_mismatch`),
 * idempotent plan and pairing writes, and 404 for anything unknown.
 */
import { Hono, type Context } from "hono";
import type * as z from "zod";
import {
  CONSOLE_AGENT_API_BASE,
  hashContext,
  postPlanRequestSchema,
  postPolicyChangeRequestSchema,
  putContextRequestSchema,
  putPairingRequestSchema,
  type ConsoleHolding,
  type ContextResponse,
  type PairingResponse,
  type PolicyChangeRequest,
  type PostPlanRequest,
} from "@mandate/shared";

export interface FakeConsoleState {
  holdings: ConsoleHolding[];
  holdingsUpdatedAt: string | null;
  contexts: Map<string, ContextResponse>;
  plans: Map<string, PostPlanRequest & { storedAt: string }>;
  changeRequests: Map<string, PolicyChangeRequest>;
  pairing: PairingResponse | null;
  /** Every request seen, as `METHOD path`, for assertions. */
  requests: string[];
}

export interface FakeConsoleOptions {
  token: string;
  /** Base of the claim links it hands out. */
  publicUrl?: string;
  holdings?: ConsoleHolding[];
  /** Whether the Policy contract names this address as its agent. Defaults to false. */
  isContractAgent?: (address: string) => boolean | Promise<boolean>;
  now?: () => Date;
}

export interface FakeConsole {
  readonly state: FakeConsoleState;
  /** Web-standard handler for the whole API. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** A `fetch` for `HttpConsoleClient` that never touches the network. */
  readonly clientFetch: (input: string, init: RequestInit) => Promise<Response>;
  /** What the owner does on the claim page. */
  readonly confirmPairing: () => void;
  /** Answer 503 to every request until set back to false. */
  readonly setDown: (down: boolean) => void;
}

function fail(c: Context, status: 401 | 404 | 422, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S> | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 422, "invalid_body", "The body is not JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(c, 422, "invalid_body", `${first?.path.join(".") ?? "body"}: ${first?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export function createFakeConsole(options: FakeConsoleOptions): FakeConsole {
  const now = options.now ?? (() => new Date());
  const publicUrl = (options.publicUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const state: FakeConsoleState = {
    holdings: options.holdings ?? [],
    holdingsUpdatedAt: options.holdings === undefined ? null : now().toISOString(),
    contexts: new Map(),
    plans: new Map(),
    changeRequests: new Map(),
    pairing: null,
    requests: [],
  };
  let down = false;
  let nextRequestId = 1;

  const app = new Hono();
  app.use("*", async (c, next) => {
    state.requests.push(`${c.req.method} ${c.req.path}`);
    if (down) return c.json({ error: { code: "unavailable", message: "Down for a test." } }, 503);
    if (c.req.header("authorization") !== `Bearer ${options.token}`) {
      return c.json({ error: { code: "unauthorized", message: "Missing or wrong service token." } }, 401);
    }
    await next();
    return undefined;
  });

  const api = new Hono();
  api.get("/holdings", (c) => c.json({ holdings: state.holdings, updatedAt: state.holdingsUpdatedAt }));

  api.put("/contexts/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    const parsed = await body(c, putContextRequestSchema);
    if (parsed instanceof Response) return parsed;
    if (hashContext(parsed.document).toLowerCase() !== hash) {
      return fail(c, 422, "hash_mismatch", "The document does not hash to the hash in the path.");
    }
    const existing = state.contexts.get(hash);
    if (existing !== undefined) return c.json(existing);
    const stored: ContextResponse = {
      hash: hash as `0x${string}`,
      document: parsed.document,
      storedAt: now().toISOString(),
    };
    state.contexts.set(hash, stored);
    return c.json(stored, 201);
  });
  api.get("/contexts/:hash", (c) => {
    const stored = state.contexts.get(c.req.param("hash").toLowerCase());
    return stored === undefined ? fail(c, 404, "not_found", "No context under this hash.") : c.json(stored);
  });

  api.post("/plans", async (c) => {
    const parsed = await body(c, postPlanRequestSchema);
    if (parsed instanceof Response) return parsed;
    const existing = state.plans.get(parsed.planId);
    if (existing !== undefined) return c.json({ planId: existing.planId, storedAt: existing.storedAt });
    const storedAt = now().toISOString();
    state.plans.set(parsed.planId, { ...parsed, storedAt });
    return c.json({ planId: parsed.planId, storedAt }, 201);
  });

  api.post("/policy-change-requests", async (c) => {
    const parsed = await body(c, postPolicyChangeRequestSchema);
    if (parsed instanceof Response) return parsed;
    const request: PolicyChangeRequest = {
      id: `pcr_${nextRequestId++}`,
      agentAddress: parsed.agentAddress,
      proposed: parsed.proposed,
      reason: parsed.reason,
      status: "pending",
      createdAt: now().toISOString(),
      resolvedAt: null,
      appliedTxHash: null,
    };
    state.changeRequests.set(request.id, request);
    return c.json(request, 201);
  });
  api.get("/policy-change-requests/:id", (c) => {
    const request = state.changeRequests.get(c.req.param("id"));
    return request === undefined ? fail(c, 404, "not_found", "No such request.") : c.json(request);
  });

  api.put("/pairing", async (c) => {
    const parsed = await body(c, putPairingRequestSchema);
    if (parsed instanceof Response) return parsed;
    const isContractAgent = (await options.isContractAgent?.(parsed.agentAddress)) ?? false;
    const keep =
      state.pairing !== null &&
      state.pairing.agentAddress.toLowerCase() === parsed.agentAddress.toLowerCase();
    state.pairing = {
      agentAddress: parsed.agentAddress,
      agentName: parsed.agentName,
      status: keep && state.pairing !== null ? state.pairing.status : "pending",
      claimUrl: `${publicUrl}/agents/claim/${parsed.agentAddress.toLowerCase()}`,
      isContractAgent,
    };
    return c.json(state.pairing);
  });
  api.get("/pairing", async (c) => {
    if (state.pairing === null) return fail(c, 404, "not_found", "The agent has not asked to pair.");
    state.pairing.isContractAgent =
      (await options.isContractAgent?.(state.pairing.agentAddress)) ?? state.pairing.isContractAgent;
    return c.json(state.pairing);
  });

  app.route(CONSOLE_AGENT_API_BASE, api);

  const handle = async (request: Request): Promise<Response> => app.fetch(request);
  return {
    state,
    fetch: handle,
    clientFetch: (input, init) => handle(new Request(input, init)),
    confirmPairing: () => {
      if (state.pairing !== null) state.pairing.status = "confirmed";
    },
    setDown: (value) => {
      down = value;
    },
  };
}
