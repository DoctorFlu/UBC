import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planHedge } from "@mandate/planner";
import {
  CONSOLE_AGENT_ROUTES,
  Category,
  type DecisionContext,
  consoleErrorSchema,
  contextResponseSchema,
  hashContext,
  holdingsResponseSchema,
  intentContextResponseSchema,
  pairingResponseSchema,
  planResponseSchema,
  policyChangeRequestSchema,
} from "@mandate/shared";
import type { EnvVars } from "@mandate/shared/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as holdingsRoute } from "@/app/api/agent/v1/holdings/route";

import { BTC_ABOVE_66K, type TestChain, startTestChain } from "../../../test/support/devchain";
import type { ConsoleConfig } from "../config";
import { setConsoleServiceForTests } from "../console";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import {
  getContext,
  getHoldings,
  getIntentContext,
  getPairing,
  getPolicyChangeRequest,
  postPlan,
  postPolicyChangeRequest,
  putContext,
  putIntentContext,
  putPairing,
} from "./agent-api";

const TOKEN = "console-service-token-for-tests-0123456789";
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const silent = { info: () => undefined, warn: () => undefined };

function makeService(options: { token?: string | null; env?: EnvVars } = {}): ConsoleService {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
  const config: ConsoleConfig = {
    dataDir,
    eventSource: "rpc",
    pollIntervalMs: 50,
    serviceToken: options.token === undefined ? TOKEN : options.token,
    streamSecurityToken: null,
    publicUrl: "http://console.test",
    mcpPublicUrl: null,
  };
  // No deployment file: the console runs without a chain, as it does before `dev:chain`.
  const env = options.env ?? { POLICY_DEPLOYMENT_FILE: join(dataDir, "missing.json") };
  return new ConsoleService(config, openDatabase(dataDir), { env, logger: silent });
}

function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://console.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = consoleErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
}

const context: DecisionContext = {
  version: 1,
  requestText: "Protect my 0.05 BTC below $66,000 this week.",
  planId: "plan_test_1",
  rungIndex: 0,
  ladderSummary: {
    eventTicker: "BTC2611202200",
    observedAt: "2026-11-14T15:50:00.000Z",
    rungs: [
      {
        instrumentSymbol: "GEMI-BTC2611202200-HI66000",
        label: "$66,000 or above",
        yesBidCents: 47,
        yesAskCents: 52,
      },
    ],
  },
  signalReceiptIds: ["rcpt_1"],
  reason: "The $66,000 rung covers the first drop below spot at the lowest cost.",
  createdAt: "2026-11-14T15:51:00.000Z",
};

function examplePlan() {
  const rung = (strike: number, noBuyCents: number) => ({
    strikeCents: strike * 100,
    instrumentSymbol: `GEMI-BTC2611202200-HI${String(strike)}`,
    label: `$${strike.toLocaleString("en-US")} or above`,
    marketState: "open" as const,
    yesBidCents: 100 - noBuyCents,
    yesAskCents: 105 - noBuyCents,
    noBuyCents,
    noSellCents: noBuyCents - 4,
    lastTradeCents: null,
  });
  const spot = 6_558_600;
  return planHedge({
    holding: { asset: "BTC", quantity: "0.05" },
    ladder: {
      asset: "BTC",
      eventTicker: "BTC2611202200",
      title: "BTC price on November 20",
      kind: "weekly",
      expiry: "2026-11-20T22:00:00.000Z",
      settlementIndex: "LS-LRRR-XBTUSD",
      spot: {
        asset: "BTC",
        symbol: "btcusd",
        bidCents: spot,
        askCents: spot,
        lastCents: spot,
        midCents: spot,
        fetchedAt: "2026-11-14T15:50:00.000Z",
      },
      rungs: [rung(64_000, 34), rung(65_000, 43), rung(66_000, 53)],
      fetchedAt: "2026-11-14T15:50:00.000Z",
    },
    goal: { floorCents: 6_400_000, ceilingCents: 6_600_000 },
    maxCostCents: 4_500,
    limits: { maxTradeCents: 10_000, remainingBudgetCents: 100_000, categoryAllowed: true },
  });
}

describe("agent API: authentication", () => {
  const service = makeService();
  const requests: [string, () => Promise<Response>][] = [
    ["GET holdings", () => getHoldings(call("GET", CONSOLE_AGENT_ROUTES.holdings, undefined, null), service)],
    ["GET pairing", () => getPairing(call("GET", CONSOLE_AGENT_ROUTES.pairing, undefined, null), service)],
    ["POST plans", () => postPlan(call("POST", CONSOLE_AGENT_ROUTES.plans, {}, null), service)],
  ];

  it.each(requests)("%s without a token is 401", async (_name, send) => {
    await expectError(await send(), 401, "unauthorized");
  });

  it("refuses a wrong token, a token of another length and a non-Bearer scheme", async () => {
    for (const header of [`Bearer ${TOKEN.slice(0, -1)}x`, `Bearer ${TOKEN}extra`, `Basic ${TOKEN}`, TOKEN]) {
      const request = new Request(`http://console.test${CONSOLE_AGENT_ROUTES.holdings}`, {
        headers: { authorization: header },
      });
      await expectError(await getHoldings(request, service), 401, "unauthorized");
    }
  });

  it("answers 503 for every route when the console has no service token", async () => {
    const unconfigured = makeService({ token: null });
    await expectError(
      await getHoldings(call("GET", CONSOLE_AGENT_ROUTES.holdings), unconfigured),
      503,
      "not_configured",
    );
  });

  it("is wired into the Next.js route", async () => {
    setConsoleServiceForTests(service);
    try {
      expect((await holdingsRoute(call("GET", CONSOLE_AGENT_ROUTES.holdings, undefined, null))).status).toBe(
        401,
      );
      expect((await holdingsRoute(call("GET", CONSOLE_AGENT_ROUTES.holdings))).status).toBe(200);
    } finally {
      setConsoleServiceForTests(undefined);
    }
  });
});

describe("agent API: holdings", () => {
  it("returns no holdings and a null time before the owner saves any, then what the owner saved", async () => {
    const service = makeService();
    const empty = holdingsResponseSchema.parse(
      await (await getHoldings(call("GET", CONSOLE_AGENT_ROUTES.holdings), service)).json(),
    );
    expect(empty).toEqual({ holdings: [], updatedAt: null });

    service.offchain.saveHoldings([{ asset: "BTC", quantity: "0.05", note: "Cold wallet" }]);
    const saved = holdingsResponseSchema.parse(
      await (await getHoldings(call("GET", CONSOLE_AGENT_ROUTES.holdings), service)).json(),
    );
    expect(saved.holdings).toEqual([{ asset: "BTC", quantity: "0.05", note: "Cold wallet" }]);
    expect(saved.updatedAt).not.toBeNull();
  });
});

describe("agent API: decision contexts", () => {
  const service = makeService();
  const hash = hashContext(context);
  const path = CONSOLE_AGENT_ROUTES.context(hash);

  it("stores a context under its hash (201), accepts it again (200) and serves it", async () => {
    const created = await putContext(call("PUT", path, { document: context }), service, { hash });
    expect(created.status).toBe(201);
    expect(contextResponseSchema.parse(await created.json())).toMatchObject({ hash, document: context });

    const again = await putContext(call("PUT", path, { document: context }), service, { hash });
    expect(again.status).toBe(200);

    const read = await getContext(call("GET", path), service, {
      hash: hash.toUpperCase().replace("0X", "0x"),
    });
    expect(read.status).toBe(200);
    expect(contextResponseSchema.parse(await read.json()).document).toEqual(context);
  });

  it("refuses a document whose hash differs from the path", async () => {
    const other = `0x${"ab".repeat(32)}`;
    const response = await putContext(
      call("PUT", CONSOLE_AGENT_ROUTES.context(other), { document: context }),
      service,
      { hash: other },
    );
    await expectError(response, 422, "hash_mismatch");
  });

  it("answers 422 for a malformed hash, an invalid document or extra keys", async () => {
    await expectError(
      await putContext(call("PUT", path, { document: context }), service, { hash: "0x1234" }),
      422,
      "invalid_parameter",
    );
    await expectError(
      await getContext(call("GET", path), service, { hash: "nope" }),
      422,
      "invalid_parameter",
    );
    await expectError(
      await putContext(call("PUT", path, { document: { ...context, version: 2 } }), service, { hash }),
      422,
      "invalid_body",
    );
    await expectError(
      await putContext(call("PUT", path, { document: context, extra: true }), service, { hash }),
      422,
      "invalid_body",
    );
    await expectError(
      await putContext(call("PUT", path, "{not json"), service, { hash }),
      422,
      "invalid_body",
    );
  });

  it("answers 404 for an unknown hash", async () => {
    const unknown = `0x${"cd".repeat(32)}`;
    await expectError(
      await getContext(call("GET", CONSOLE_AGENT_ROUTES.context(unknown)), service, { hash: unknown }),
      404,
      "not_found",
    );
  });
});

describe("agent API: hedge plans", () => {
  const service = makeService();
  const plan = examplePlan();
  const body = {
    planId: plan.planId,
    asset: "BTC",
    requestText: "Protect my 0.05 BTC below $66,000 this week.",
    createdAt: "2026-11-14T15:51:00.000Z",
    plan,
  };

  it("stores a planner plan once and returns the stored record on a repeat", async () => {
    const created = await postPlan(call("POST", CONSOLE_AGENT_ROUTES.plans, body), service);
    expect(created.status).toBe(201);
    const first = planResponseSchema.parse(await created.json());
    expect(first.planId).toBe(plan.planId);

    const repeated = await postPlan(
      call("POST", CONSOLE_AGENT_ROUTES.plans, { ...body, requestText: "changed" }),
      service,
    );
    expect(repeated.status).toBe(200);
    expect(planResponseSchema.parse(await repeated.json())).toEqual(first);
    expect(service.offchain.plan(plan.planId)?.requestText).toBe(body.requestText);
  });

  it("shows the latest plan of each asset in the snapshot, read back as the planner typed it", async () => {
    const fresh = makeService();
    const eth = { ...plan, planId: "plan_eth_1", asset: "ETH" };
    const later = { ...plan, planId: "plan_btc_2" };
    for (const next of [plan, eth, later]) {
      const response = await postPlan(
        call("POST", CONSOLE_AGENT_ROUTES.plans, {
          ...body,
          planId: next.planId,
          asset: next.asset,
          plan: next,
        }),
        fresh,
      );
      expect(response.status).toBe(201);
    }
    const plans = fresh.snapshot().offchain.plans;
    expect(plans.map((entry) => [entry.asset, entry.planId])).toEqual([
      ["BTC", "plan_btc_2"],
      ["ETH", "plan_eth_1"],
    ]);
    expect(plans[0]?.plan).toEqual(later);
    expect(plans[0]).toMatchObject({ requestText: body.requestText, createdAt: body.createdAt });
  });

  it("refuses a plan that is not a planner HedgePlan, or whose id does not match", async () => {
    await expectError(
      await postPlan(
        call("POST", CONSOLE_AGENT_ROUTES.plans, { ...body, plan: { planId: plan.planId } }),
        service,
      ),
      422,
      "invalid_plan",
    );
    await expectError(
      await postPlan(call("POST", CONSOLE_AGENT_ROUTES.plans, { ...body, planId: "other-plan" }), service),
      422,
      "plan_mismatch",
    );
    await expectError(
      await postPlan(call("POST", CONSOLE_AGENT_ROUTES.plans, { ...body, asset: "btc" }), service),
      422,
      "invalid_body",
    );
  });
});

describe("agent API: policy change requests", () => {
  const service = makeService();

  it("files a pending request and returns it by id", async () => {
    const created = await postPolicyChangeRequest(
      call("POST", CONSOLE_AGENT_ROUTES.policyChangeRequests, {
        agentAddress: AGENT,
        proposed: { maxTradeCents: 7_500 },
        reason: "Rung 3 costs $62; splitting it costs more in fees.",
      }),
      service,
    );
    expect(created.status).toBe(201);
    const request = policyChangeRequestSchema.parse(await created.json());
    expect(request).toMatchObject({
      status: "pending",
      proposed: { maxTradeCents: 7_500 },
      resolvedAt: null,
      appliedTxHash: null,
    });

    const read = await getPolicyChangeRequest(
      call("GET", CONSOLE_AGENT_ROUTES.policyChangeRequest(request.id)),
      service,
      { id: request.id },
    );
    expect(policyChangeRequestSchema.parse(await read.json())).toEqual(request);
    expect(service.snapshot().offchain.changeRequests[0]?.id).toBe(request.id);
  });

  it("refuses a request without a reason, without a change, or one that tries to unpause", async () => {
    const bodies = [
      { agentAddress: AGENT, proposed: { maxTradeCents: 7_500 }, reason: "  " },
      { agentAddress: AGENT, proposed: {}, reason: "Because." },
      { agentAddress: AGENT, proposed: { paused: false }, reason: "Let me trade." },
      { agentAddress: "0x1234", proposed: { maxTradeCents: 1 }, reason: "Because." },
    ];
    for (const body of bodies) {
      await expectError(
        await postPolicyChangeRequest(call("POST", CONSOLE_AGENT_ROUTES.policyChangeRequests, body), service),
        422,
        "invalid_body",
      );
    }
  });

  it("answers 404 for an unknown id", async () => {
    await expectError(
      await getPolicyChangeRequest(call("GET", CONSOLE_AGENT_ROUTES.policyChangeRequest("nope")), service, {
        id: "nope",
      }),
      404,
      "not_found",
    );
  });
});

describe("agent API: pairing", () => {
  let chain: TestChain;
  let service: ConsoleService;

  beforeAll(async () => {
    chain = await startTestChain();
    service = makeService({ env: chain.env });
    service.start();
    if (!(await service.whenSynced(15_000))) throw new Error("the console did not sync");
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("answers 404 before any agent announced itself", async () => {
    await expectError(await getPairing(call("GET", CONSOLE_AGENT_ROUTES.pairing), service), 404, "not_found");
  });

  it("records an announcement idempotently, with a claim link and whether the contract knows the agent", async () => {
    const announcement = { agentAddress: AGENT, agentName: "Grok Bot", serverVersion: "0.1.0" };
    const first = pairingResponseSchema.parse(
      await (await putPairing(call("PUT", CONSOLE_AGENT_ROUTES.pairing, announcement), service)).json(),
    );
    expect(first).toEqual({
      agentAddress: AGENT,
      agentName: "Grok Bot",
      status: "pending",
      claimUrl: `http://console.test/setup/pair/${AGENT}`,
      isContractAgent: true,
    });

    service.offchain.confirmPairing(AGENT, chain.user.account?.address ?? AGENT);
    const again = pairingResponseSchema.parse(
      await (await putPairing(call("PUT", CONSOLE_AGENT_ROUTES.pairing, announcement), service)).json(),
    );
    expect(again.status).toBe("confirmed");
    const read = pairingResponseSchema.parse(
      await (await getPairing(call("GET", CONSOLE_AGENT_ROUTES.pairing), service)).json(),
    );
    expect(read).toEqual(again);
  });

  it("says when the announced agent is not the contract's agent", async () => {
    const stranger = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
    const body = pairingResponseSchema.parse(
      await (
        await putPairing(
          call("PUT", CONSOLE_AGENT_ROUTES.pairing, {
            agentAddress: stranger,
            agentName: "Impostor",
            serverVersion: "1",
          }),
          service,
        )
      ).json(),
    );
    expect(body.isContractAgent).toBe(false);
  });

  it("refuses a malformed announcement", async () => {
    await expectError(
      await putPairing(
        call("PUT", CONSOLE_AGENT_ROUTES.pairing, { agentAddress: AGENT, agentName: "", serverVersion: "1" }),
        service,
      ),
      422,
      "invalid_body",
    );
  });
});

describe("agent API: intent to context links", () => {
  let chain: TestChain;
  let service: ConsoleService;

  beforeAll(async () => {
    // The production contract records no contextHash onchain: the link is the only way to seal a reason.
    chain = await startTestChain({ contract: "production" });
    service = makeService({ env: chain.env });
    service.start();
    if (!(await service.whenSynced(15_000))) throw new Error("the console did not sync");
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  const propose = () =>
    chain.agent.proposeTrade({
      market: BTC_ABOVE_66K,
      category: Category.Crypto,
      outcome: "NO",
      isBuy: true,
      amountCents: 1_000,
      limitPrice: 31,
    });
  const link = (intentId: number | string, body: unknown) =>
    putIntentContext(call("PUT", CONSOLE_AGENT_ROUTES.intentContext(intentId), body), service, {
      intentId: String(intentId),
    });
  const sealedOf = async (intentId: number) => {
    await expect
      .poll(() => service.snapshot().chain?.intents.some((intent) => intent.id === intentId))
      .toBe(true);
    return service.snapshot().chain?.sealed[intentId];
  };

  it("links an intent once, idempotently, and shows the reason as recorded offchain and verified", async () => {
    const proposal = await propose();
    const hash = hashContext(context);
    await putContext(call("PUT", CONSOLE_AGENT_ROUTES.context(hash), { document: context }), service, {
      hash,
    });

    const created = await link(proposal.intentId, { hash, txHash: proposal.txHash });
    expect(created.status).toBe(201);
    expect(intentContextResponseSchema.parse(await created.json())).toMatchObject({
      intentId: proposal.intentId,
      hash,
      txHash: proposal.txHash,
    });
    const again = await link(proposal.intentId, { hash, txHash: proposal.txHash });
    expect(again.status).toBe(200);

    const read = await getIntentContext(
      call("GET", CONSOLE_AGENT_ROUTES.intentContext(proposal.intentId)),
      service,
      { intentId: String(proposal.intentId) },
    );
    expect(intentContextResponseSchema.parse(await read.json()).hash).toBe(hash);
    expect(await sealedOf(proposal.intentId)).toMatchObject({ status: "verified", source: "offchain", hash });
  });

  it("refuses a different hash for a linked intent with 409 conflict", async () => {
    const proposal = await propose();
    const hash = hashContext(context);
    expect((await link(proposal.intentId, { hash, txHash: proposal.txHash })).status).toBe(201);
    await expectError(
      await link(proposal.intentId, { hash: `0x${"ef".repeat(32)}`, txHash: proposal.txHash }),
      409,
      "conflict",
    );
  });

  it("says not stored when the linked document is missing, and ignores a link to another transaction", async () => {
    const missing = await propose();
    const unknownHash = `0x${"ab".repeat(32)}`;
    await link(missing.intentId, { hash: unknownHash, txHash: missing.txHash });
    expect(await sealedOf(missing.intentId)).toMatchObject({ status: "not_stored", source: "offchain" });

    const elsewhere = await propose();
    await link(elsewhere.intentId, { hash: hashContext(context), txHash: missing.txHash });
    expect(await sealedOf(elsewhere.intentId)).toBeUndefined();
  });

  it("answers 404, 422 and 401 where it should", async () => {
    await expectError(
      await getIntentContext(call("GET", CONSOLE_AGENT_ROUTES.intentContext(9_999)), service, {
        intentId: "9999",
      }),
      404,
      "not_found",
    );
    const tx = `0x${"12".repeat(32)}`;
    const hash = `0x${"34".repeat(32)}`;
    await expectError(await link("-1", { hash, txHash: tx }), 422, "invalid_parameter");
    await expectError(await link("01", { hash, txHash: tx }), 422, "invalid_parameter");
    await expectError(await link(0, { hash }), 422, "invalid_body");
    await expectError(await link(0, { hash, txHash: tx, extra: 1 }), 422, "invalid_body");
    const unsigned = await putIntentContext(
      call("PUT", CONSOLE_AGENT_ROUTES.intentContext(0), { hash, txHash: tx }, null),
      service,
      { intentId: "0" },
    );
    await expectError(unsigned, 401, "unauthorized");
  });

  it("answers 503 before the console follows a contract", async () => {
    const idle = makeService();
    const tx = `0x${"12".repeat(32)}`;
    await expectError(
      await putIntentContext(
        call("PUT", CONSOLE_AGENT_ROUTES.intentContext(0), { hash: tx, txHash: tx }),
        idle,
        { intentId: "0" },
      ),
      503,
      "chain_unavailable",
    );
  });
});
