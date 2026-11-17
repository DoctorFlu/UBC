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
 *
 * It is multi-tenant like the real one (docs/accounts.md): each agent has its own records, every call
 * names its agent in `x-mandate-agent` (400 without, 404 for an unknown one), and `auth/resolve` answers
 * which agent a token's hash belongs to. The env-file token registers itself for the first mandate's
 * agent (`env`) the first time it is presented with `legacy: true`, and once revoked stays revoked.
 * `addAgent` adds another workspace's agent with a console-issued token, and can hold its key to sign.
 *
 * It also takes the executor's settlements (`CONSOLE_EXECUTOR_ROUTES`, issue #92) the way the console
 * does: no bearer token, a document that adds up, a signature that recovers to `executorAddress` when
 * one is given, and the first record of an intent wins (200 for the same one, 409 `conflict` otherwise).
 * The settlements belong to the server's contract, so they are the first mandate's (`env`) records.
 * It does not check the fill onchain; the real console does.
 */
import type { GeminiEnvironment } from "@mandate/gemini";
import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import type * as z from "zod";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGENT_ID_HEADER,
  CONSOLE_AGENT_API_BASE,
  CONSOLE_EXECUTOR_API_BASE,
  ENV_AGENT_ID,
  type MandateDeploymentKind,
  agentTransactionRefusal,
  fromUnsignedTransaction,
  hashAgentToken,
  hashContext,
  hashSettlement,
  putSettlementRequestSchema,
  settlementMessage,
  settlementProblems,
  type StoredSettlement,
  postPlanRequestSchema,
  postPolicyChangeRequestSchema,
  putContextRequestSchema,
  putIntentContextRequestSchema,
  putPairingRequestSchema,
  putSignalBudgetRequestSchema,
  putSignalPaymentRequestSchema,
  resolveTokenRequestSchema,
  signTransactionRequestSchema,
  type ConsoleHolding,
  type ContextResponse,
  type CoverNowView,
  type SummaryResponse,
  type IntentContextResponse,
  type PairingResponse,
  type PolicyChangeRequest,
  type PostPlanRequest,
  type PutSignalPaymentRequest,
  type ResolveTokenResponse,
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
  /** Settlements by intent id, as the executor first recorded them (the first mandate's only). */
  settlements: Map<number, StoredSettlement>;
  /** Every request seen, as `METHOD path`, for assertions (on the first agent's state: all agents'). */
  requests: string[];
}

export interface FakeConsoleOptions {
  token: string;
  /** Base of the claim links it hands out. */
  publicUrl?: string;
  holdings?: ConsoleHolding[];
  /** Whether the Policy contract names this address as its agent. Defaults to false. */
  isContractAgent?: (address: string) => boolean | Promise<boolean>;
  /** The contract's executor: a settlement signed by anyone else is refused (403). Any signer when unset. */
  executorAddress?: Address;
  /**
   * The cover held now against each current goal, which the real console measures on Gemini's quotes
   * (`GET /summary`). None when unset.
   */
  cover?: (state: FakeConsoleState) => CoverNowView[] | Promise<CoverNowView[]>;
  now?: () => Date;
  /** Which Gemini its public `GET /api/health` says it reads. Production by default. */
  marketEnvironment?: GeminiEnvironment;
}

/** Another workspace's agent, as `addAgent` creates it. */
export interface FakeAgent {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly mandateId: string;
  /** Its console-issued token (`mdt_...`), shown once like the real console does. */
  readonly token: string;
  readonly tokenId: string;
  readonly address: Address | null;
  readonly state: FakeConsoleState;
}

export interface FakeConsole {
  /** The first mandate's agent's records (`env`). */
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
  /** Change the Gemini environment its health answer names. */
  readonly setMarketEnvironment: (environment: GeminiEnvironment) => void;
  /** A new workspace with one mandate (no contract unless `contract` is given) and its agent. */
  readonly addAgent: (options?: {
    /** The agent's key, which this console holds and signs with. */
    privateKey?: Hex;
    /** The mandate's contract: the agent may sign `proposeTrade` to it, on its chain. */
    contract?: { policyAddress: Address; chainId: number };
    /**
     * Whose contract that is: the server's (`env`, the default), or the mandate's own (`server`), which
     * the console then names in its answer with this deploy block (#95).
     */
    own?: { deployBlock: number };
  }) => FakeAgent;
  /** Another console-issued token for an agent. */
  readonly issueToken: (agentId: string) => { token: string; tokenId: string };
  /** Revokes a token at once, like the owner does in Setup. */
  readonly revokeToken: (token: string) => void;
  /** Renames the agent's mandate, like an admin does in Setup: the next resolve names it so. */
  readonly renameMandate: (agentId: string, name: string) => void;
  /** The records of an agent. */
  readonly stateOf: (agentId: string) => FakeConsoleState;
}

function fail(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422,
  code: string,
  message: string,
): Response {
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

const base32 = (bytes: number) =>
  [...randomBytes(bytes)].map((byte) => "0123456789abcdefghjkmnpqrstvwxyz".charAt(byte % 32)).join("");

interface AgentRecord {
  agentId: string;
  workspaceId: string;
  mandateId: string;
  /** The mandate's name, which an admin can change at any time (`renameMandate`). */
  mandateName: string;
  address: Address | null;
  signer: "env" | "console";
  deployment: MandateDeploymentKind | null;
  privateKey: Hex | null;
  contract: { policyAddress: Address; chainId: number } | null;
  /** The deploy block of the mandate's own contract (`deployment: "server"`). */
  deployBlock: number | null;
  state: FakeConsoleState;
}

interface TokenRecord {
  tokenId: string;
  agentId: string;
  source: "env" | "console";
  revoked: boolean;
}

export function createFakeConsole(options: FakeConsoleOptions): FakeConsole {
  const now = options.now ?? (() => new Date());
  const publicUrl = (options.publicUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const newState = (holdings?: ConsoleHolding[]): FakeConsoleState => ({
    holdings: holdings ?? [],
    holdingsUpdatedAt: holdings === undefined ? null : now().toISOString(),
    contexts: new Map(),
    intentContexts: new Map(),
    plans: new Map(),
    changeRequests: new Map(),
    pairing: null,
    signalPayments: new Map(),
    signalBudget: null,
    settlements: new Map(),
    requests: [],
  });
  const state = newState(options.holdings);
  const agents = new Map<string, AgentRecord>([
    [
      ENV_AGENT_ID,
      {
        agentId: ENV_AGENT_ID,
        workspaceId: "wsp_first",
        mandateId: "mnd_first",
        mandateName: "Mandate",
        address: null,
        signer: "env",
        deployment: "env",
        privateKey: null,
        contract: null,
        deployBlock: null,
        state,
      },
    ],
  ]);
  /** Token hash to its record. */
  const tokens = new Map<string, TokenRecord>();
  let down = false;
  let signalRoutes = true;
  let nextRequestId = 1;
  let marketEnvironment: GeminiEnvironment = options.marketEnvironment ?? "production";

  const issueToken = (agentId: string) => {
    const token = `mdt_${randomBytes(32).toString("base64url")}`;
    const tokenId = `tok_${base32(26)}`;
    tokens.set(hashAgentToken(token), { tokenId, agentId, source: "console", revoked: false });
    return { token, tokenId };
  };

  const app = new Hono();
  app.use("*", async (c, next) => {
    state.requests.push(`${c.req.method} ${c.req.path}`);
    if (down) return c.json({ error: { code: "unavailable", message: "Down for a test." } }, 503);
    // The executor API has no token: a settlement is only stored when the executor signed it.
    const isExecutorApi = c.req.path.startsWith(`${CONSOLE_EXECUTOR_API_BASE}/`);
    if (!isExecutorApi && c.req.header("authorization") !== `Bearer ${options.token}`) {
      return c.json({ error: { code: "unauthorized", message: "Missing or wrong service token." } }, 401);
    }
    await next();
    return undefined;
  });

  // Which agent a token's hash belongs to: the one route that names no agent.
  app.post(`${CONSOLE_AGENT_API_BASE}/auth/resolve`, async (c) => {
    const parsed = await body(c, resolveTokenRequestSchema);
    if (parsed instanceof Response) return parsed;
    let record = tokens.get(parsed.tokenHash);
    if (record === undefined && parsed.legacy) {
      const registered = [...tokens.values()].some((t) => t.agentId === ENV_AGENT_ID && t.source === "env");
      if (!registered) {
        record = { tokenId: `tok_${base32(26)}`, agentId: ENV_AGENT_ID, source: "env", revoked: false };
        tokens.set(parsed.tokenHash, record);
      }
    }
    if (record === undefined || record.revoked || (record.source === "env") !== parsed.legacy) {
      return fail(c, 404, "unknown_token", "No live agent token has that hash.");
    }
    const agent = agents.get(record.agentId);
    if (agent === undefined) return fail(c, 404, "unknown_token", "No live agent token has that hash.");
    const answer: ResolveTokenResponse = {
      workspaceId: agent.workspaceId,
      mandateId: agent.mandateId,
      agentId: agent.agentId,
      tokenId: record.tokenId,
      agent: { address: agent.address, signer: agent.signer },
      mandate: {
        name: agent.mandateName,
        deployment: agent.deployment,
        contract:
          agent.deployment === "server" && agent.contract !== null && agent.deployBlock !== null
            ? {
                chainId: agent.contract.chainId,
                address: agent.contract.policyAddress,
                deployBlock: agent.deployBlock,
              }
            : null,
      },
    };
    return c.json(answer);
  });

  // The agent each request names, set by the middleware below.
  const agentOf = new WeakMap<Request, AgentRecord>();
  const api = new Hono();
  api.use("*", async (c, next) => {
    const id = c.req.header(AGENT_ID_HEADER);
    if (id === undefined || id.trim() === "") {
      const message = `Name the agent the request is for in the ${AGENT_ID_HEADER} header.`;
      return c.json({ error: { code: "agent_required", message } }, 400);
    }
    const agent = agents.get(id.trim());
    if (agent === undefined) {
      return c.json({ error: { code: "unknown_agent", message: "No agent has that id." } }, 404);
    }
    agentOf.set(c.req.raw, agent);
    await next();
    return undefined;
  });
  const agentFor = (c: Context): AgentRecord => {
    const agent = agentOf.get(c.req.raw);
    if (agent === undefined) throw new Error("no agent for this request");
    return agent;
  };
  const tenant = (c: Context) => agentFor(c).state;

  api.get("/holdings", (c) => {
    const t = tenant(c);
    return c.json({ holdings: t.holdings, updatedAt: t.holdingsUpdatedAt });
  });

  api.put("/contexts/:hash", async (c) => {
    const t = tenant(c);
    const hash = c.req.param("hash").toLowerCase();
    const parsed = await body(c, putContextRequestSchema);
    if (parsed instanceof Response) return parsed;
    if (hashContext(parsed.document).toLowerCase() !== hash) {
      return fail(c, 422, "hash_mismatch", "The document does not hash to the hash in the path.");
    }
    const existing = t.contexts.get(hash);
    if (existing !== undefined) return c.json(existing);
    const stored: ContextResponse = {
      hash: hash as `0x${string}`,
      document: parsed.document,
      storedAt: now().toISOString(),
    };
    t.contexts.set(hash, stored);
    return c.json(stored, 201);
  });
  api.get("/contexts/:hash", (c) => {
    const stored = tenant(c).contexts.get(c.req.param("hash").toLowerCase());
    return stored === undefined ? fail(c, 404, "not_found", "No context under this hash.") : c.json(stored);
  });

  api.put("/intents/:intentId/context", async (c) => {
    const t = tenant(c);
    const raw = c.req.param("intentId");
    if (!/^(0|[1-9]\d{0,15})$/.test(raw)) {
      return fail(c, 422, "invalid_parameter", "The intent id must be a whole number, starting at 0.");
    }
    const intentId = Number(raw);
    const parsed = await body(c, putIntentContextRequestSchema);
    if (parsed instanceof Response) return parsed;
    const existing = t.intentContexts.get(intentId);
    if (existing !== undefined) {
      if (existing.hash.toLowerCase() === parsed.hash.toLowerCase()) return c.json(existing);
      return fail(c, 409, "conflict", `Intent ${raw} is already linked to another context.`);
    }
    const link: IntentContextResponse = { intentId, ...parsed, linkedAt: now().toISOString() };
    t.intentContexts.set(intentId, link);
    return c.json(link, 201);
  });
  api.get("/intents/:intentId/context", (c) => {
    const link = tenant(c).intentContexts.get(Number(c.req.param("intentId")));
    return link === undefined ? fail(c, 404, "not_found", "No linked context.") : c.json(link);
  });

  api.post("/plans", async (c) => {
    const t = tenant(c);
    const parsed = await body(c, postPlanRequestSchema);
    if (parsed instanceof Response) return parsed;
    const existing = t.plans.get(parsed.planId);
    if (existing !== undefined) return c.json({ planId: existing.planId, storedAt: existing.storedAt });
    const storedAt = now().toISOString();
    t.plans.set(parsed.planId, { ...parsed, storedAt });
    return c.json({ planId: parsed.planId, storedAt }, 201);
  });

  api.post("/policy-change-requests", async (c) => {
    const t = tenant(c);
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
    t.changeRequests.set(request.id, request);
    return c.json(request, 201);
  });
  api.get("/policy-change-requests/:id", (c) => {
    const request = tenant(c).changeRequests.get(c.req.param("id"));
    return request === undefined ? fail(c, 404, "not_found", "No such request.") : c.json(request);
  });

  api.put("/pairing", async (c) => {
    const t = tenant(c);
    const parsed = await body(c, putPairingRequestSchema);
    if (parsed instanceof Response) return parsed;
    const isContractAgent = (await options.isContractAgent?.(parsed.agentAddress)) ?? false;
    const keep =
      t.pairing !== null && t.pairing.agentAddress.toLowerCase() === parsed.agentAddress.toLowerCase();
    t.pairing = {
      agentAddress: parsed.agentAddress,
      agentName: parsed.agentName,
      status: keep && t.pairing !== null ? t.pairing.status : "pending",
      claimUrl: `${publicUrl}/agents/claim/${parsed.agentAddress.toLowerCase()}`,
      isContractAgent,
    };
    return c.json(t.pairing);
  });
  api.get("/pairing", async (c) => {
    const t = tenant(c);
    if (t.pairing === null) return fail(c, 404, "not_found", "The agent has not asked to pair.");
    t.pairing.isContractAgent =
      (await options.isContractAgent?.(t.pairing.agentAddress)) ?? t.pairing.isContractAgent;
    return c.json(t.pairing);
  });

  api.put("/signal-payments/:receiptId", async (c) => {
    if (!signalRoutes) return c.notFound();
    const t = tenant(c);
    const receiptId = c.req.param("receiptId").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(receiptId)) {
      return fail(c, 422, "invalid_parameter", "The receipt id must be a 0x-prefixed 32-byte hex string.");
    }
    const parsed = await body(c, putSignalPaymentRequestSchema);
    if (parsed instanceof Response) return parsed;
    const existing = t.signalPayments.get(receiptId);
    if (existing !== undefined) return c.json({ receiptId, recordedAt: existing.recordedAt });
    const recordedAt = now().toISOString();
    t.signalPayments.set(receiptId, { ...parsed, recordedAt });
    return c.json({ receiptId, recordedAt }, 201);
  });

  api.put("/signal-budget", async (c) => {
    if (!signalRoutes) return c.notFound();
    const t = tenant(c);
    const parsed = await body(c, putSignalBudgetRequestSchema);
    if (parsed instanceof Response) return parsed;
    if (t.signalBudget === null || Date.parse(parsed.asOf) >= Date.parse(t.signalBudget.asOf)) {
      t.signalBudget = { ...parsed, storedAt: now().toISOString() };
    }
    return c.json(t.signalBudget);
  });

  // Signs as an agent whose key this console holds: only `proposeTrade` to its own contract.
  api.post("/signer/transactions", async (c) => {
    const agent = agentFor(c);
    const parsed = await body(c, signTransactionRequestSchema);
    if (parsed instanceof Response) return parsed;
    if (agent.privateKey === null || agent.contract === null) {
      return fail(
        c,
        409,
        "no_key",
        "The console holds no key for this agent, or its mandate has no contract.",
      );
    }
    const refusal = agentTransactionRefusal(parsed.transaction, agent.contract);
    if (refusal !== null) return fail(c, 422, "refused", `Not signed: ${refusal}.`);
    const signed = await privateKeyToAccount(agent.privateKey).signTransaction(
      fromUnsignedTransaction(parsed.transaction),
    );
    return c.json({ signed });
  });

  api.get("/settlements", (c) =>
    c.json({
      settlements: [...tenant(c).settlements.values()].sort(
        (a, b) => b.storedAt.localeCompare(a.storedAt) || b.intentId - a.intentId,
      ),
    }),
  );

  api.get("/summary", async (c) => {
    const t = tenant(c);
    const answer: SummaryResponse = {
      consoleUrl: publicUrl,
      changeRequests: [...t.changeRequests.values()].filter((r) => r.status === "pending").reverse(),
      cover: (await options.cover?.(t)) ?? [],
      asOf: now().toISOString(),
    };
    return c.json(answer);
  });

  const executor = new Hono();
  executor.put("/settlements/:intentId", async (c) => {
    const raw = c.req.param("intentId");
    if (!/^(0|[1-9]\d{0,15})$/.test(raw)) {
      return fail(c, 422, "invalid_parameter", "The intent id must be a whole number, starting at 0.");
    }
    const intentId = Number(raw);
    const parsed = await body(c, putSettlementRequestSchema);
    if (parsed instanceof Response) return parsed;
    const { document, signature } = parsed;
    if (document.intentId !== intentId) {
      return fail(c, 422, "intent_mismatch", "The document's intentId must be the intent id in the path.");
    }
    const problems = settlementProblems(document);
    if (problems.length > 0) return fail(c, 422, "invalid_settlement", problems.join("; "));
    const hash = hashSettlement(document);
    const signer = await recoverMessageAddress({ message: settlementMessage(hash), signature });
    if (options.executorAddress !== undefined && !isAddressEqual(signer, options.executorAddress)) {
      return fail(c, 403, "not_executor", "The settlement is not signed by the contract's executor.");
    }
    const existing = state.settlements.get(intentId);
    if (existing !== undefined) {
      if (existing.hash === hash) return c.json(existing);
      return fail(c, 409, "conflict", `Intent ${raw} already has a settlement; the first record stands.`);
    }
    const stored: StoredSettlement = {
      intentId,
      hash,
      document,
      signature,
      signer,
      storedAt: now().toISOString(),
    };
    state.settlements.set(intentId, stored);
    return c.json(stored, 201);
  });

  app.route(CONSOLE_AGENT_API_BASE, api);
  app.route(CONSOLE_EXECUTOR_API_BASE, executor);
  app.get("/api/health", (c) => c.json({ status: "ok", feed: "live", marketEnvironment }));

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
    setMarketEnvironment: (environment) => {
      marketEnvironment = environment;
    },
    setSignalRoutes: (served) => {
      signalRoutes = served;
    },
    addAgent: (agentOptions = {}) => {
      const agentId = `agt_${base32(26)}`;
      const address =
        agentOptions.privateKey === undefined ? null : privateKeyToAccount(agentOptions.privateKey).address;
      const record: AgentRecord = {
        agentId,
        workspaceId: `wsp_${base32(26)}`,
        mandateId: `mnd_${base32(26)}`,
        mandateName: "Mandate",
        address,
        signer: "console",
        deployment: agentOptions.contract === undefined ? null : agentOptions.own ? "server" : "env",
        privateKey: agentOptions.privateKey ?? null,
        contract: agentOptions.contract ?? null,
        deployBlock: agentOptions.own?.deployBlock ?? null,
        state: newState(),
      };
      agents.set(agentId, record);
      const issued = issueToken(agentId);
      return {
        agentId,
        workspaceId: record.workspaceId,
        mandateId: record.mandateId,
        token: issued.token,
        tokenId: issued.tokenId,
        address,
        state: record.state,
      };
    },
    issueToken,
    revokeToken: (token) => {
      const record = tokens.get(hashAgentToken(token));
      if (record !== undefined) record.revoked = true;
    },
    renameMandate: (agentId, name) => {
      const agent = agents.get(agentId);
      if (agent === undefined) throw new Error(`no agent ${agentId}`);
      agent.mandateName = name;
    },
    stateOf: (agentId) => {
      const agent = agents.get(agentId);
      if (agent === undefined) throw new Error(`no agent ${agentId}`);
      return agent.state;
    },
  };
}
