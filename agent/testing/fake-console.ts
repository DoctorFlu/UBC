/**
 * An in-memory console backend that implements the agent API in `@mandate/shared` `console-api.ts`
 * with the same schemas, for tests and the end-to-end smoke run. It is not production code: the
 * real console lives in `dashboard/`.
 *
 * It behaves like the contract describes: bearer auth (401), schema validation (422 with a
 * `consoleErrorSchema` body), hash verification of decision contexts (422 `hash_mismatch`),
 * idempotent plan, pairing and intent-link writes (a different hash for a linked intent is 409
 * `conflict`), signal payments recorded once per receipt id (first write wins), a budget snapshot
 * where the latest `asOf` wins, and 404 for anything unknown. `setSignalRoutes(false)` makes the two
 * signal routes answer 404, like a console that does not implement them yet.
 */
import { Hono, type Context } from "hono";
import type * as z from "zod";
import {
  CONSOLE_AGENT_API_BASE,
  hashContext,
  postPlanRequestSchema,
  postPolicyChangeRequestSchema,
  putContextRequestSchema,
  putIntentContextRequestSchema,
  putPairingRequestSchema,
  putSignalBudgetRequestSchema,
  putSignalPaymentRequestSchema,
  type ConsoleHolding,
  type ContextResponse,
  type IntentContextResponse,
  type PairingResponse,
  type PolicyChangeRequest,
  type PostPlanRequest,
  type PutSignalPaymentRequest,
  type SignalBudgetResponse,
} from "@mandate/shared";

export interface FakeConsoleState {
  holdings: ConsoleHolding[];
  holdingsUpdatedAt: string | null;
  contexts: Map<string, ContextResponse>;
  /** Intent id to the decision context that explains it. */
  intentContexts: Map<number, IntentContextResponse>;
  plans: Map<string, PostPlanRequest & { storedAt: string }>;
  changeRequests: Map<string, PolicyChangeRequest>;
  pairing: PairingResponse | null;
  /** Signal payments by receipt id (lower case), as first recorded. */
  signalPayments: Map<string, PutSignalPaymentRequest & { recordedAt: string }>;
  /** The latest signal budget snapshot. */
  signalBudget: SignalBudgetResponse | null;
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
  /** Serve the signal payment and budget routes (default), or answer 404 as a console without them. */
  readonly setSignalRoutes: (served: boolean) => void;
}

function fail(c: Context, status: 401 | 404 | 409 | 422, code: string, message: string): Response {
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
    intentContexts: new Map(),
    plans: new Map(),
    changeRequests: new Map(),
    pairing: null,
    signalPayments: new Map(),
    signalBudget: null,
    requests: [],
  };
  let down = false;
  let signalRoutes = true;
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

  api.put("/intents/:intentId/context", async (c) => {
    const raw = c.req.param("intentId");
    if (!/^(0|[1-9]\d{0,15})$/.test(raw)) {
      return fail(c, 422, "invalid_parameter", "The intent id must be a whole number, starting at 0.");
    }
    const intentId = Number(raw);
    const parsed = await body(c, putIntentContextRequestSchema);
    if (parsed instanceof Response) return parsed;
    const existing = state.intentContexts.get(intentId);
    if (existing !== undefined) {
      if (existing.hash.toLowerCase() === parsed.hash.toLowerCase()) return c.json(existing);
      return fail(c, 409, "conflict", `Intent ${raw} is already linked to another context.`);
    }
    const link: IntentContextResponse = { intentId, ...parsed, linkedAt: now().toISOString() };
    state.intentContexts.set(intentId, link);
    return c.json(link, 201);
  });
  api.get("/intents/:intentId/context", (c) => {
    const link = state.intentContexts.get(Number(c.req.param("intentId")));
    return link === undefined ? fail(c, 404, "not_found", "No linked context.") : c.json(link);
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

  api.put("/signal-payments/:receiptId", async (c) => {
    if (!signalRoutes) return c.notFound();
    const receiptId = c.req.param("receiptId").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(receiptId)) {
      return fail(c, 422, "invalid_parameter", "The receipt id must be a 0x-prefixed 32-byte hex string.");
    }
    const parsed = await body(c, putSignalPaymentRequestSchema);
    if (parsed instanceof Response) return parsed;
    const existing = state.signalPayments.get(receiptId);
    if (existing !== undefined) return c.json({ receiptId, recordedAt: existing.recordedAt });
    const recordedAt = now().toISOString();
    state.signalPayments.set(receiptId, { ...parsed, recordedAt });
    return c.json({ receiptId, recordedAt }, 201);
  });

  api.put("/signal-budget", async (c) => {
    if (!signalRoutes) return c.notFound();
    const parsed = await body(c, putSignalBudgetRequestSchema);
    if (parsed instanceof Response) return parsed;
    if (state.signalBudget === null || Date.parse(parsed.asOf) >= Date.parse(state.signalBudget.asOf)) {
      state.signalBudget = { ...parsed, storedAt: now().toISOString() };
    }
    return c.json(state.signalBudget);
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
    setSignalRoutes: (served) => {
      signalRoutes = served;
    },
  };
}
