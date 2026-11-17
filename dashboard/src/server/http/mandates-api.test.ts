import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_ID_HEADER,
  CONSOLE_AGENT_ROUTES,
  Category,
  PolicyClient,
  WriteLane,
  type PolicyRules,
  type Settlement,
  type OrderIdDeployment,
  type VenueOrderRecord,
  type WakeEvent,
  WakeTarget,
  clientOrderIdFor,
  consoleErrorSchema,
  contractsBought,
  hashAgentToken,
  hashSettlement,
  policyAbi,
  resolveTokenResponseSchema,
  settlementMessage,
  ordersResponseSchema,
  settlementsResponseSchema,
  signerAccount,
  summaryResponseSchema,
  wakeEventSchema,
} from "@mandate/shared";
import {
  consoleContractDiscovery,
  consoleOrderJournal,
  consoleSettlementSink,
  startExecutor,
  startExecutorFleet,
  venueDeployment,
} from "@mandate/devchain";
import { type Address, createWalletClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreatedMandateResponse, MandateView, MandatesResponse } from "@/lib/accounts/types";
import type { OwnerCall } from "@/lib/owner/calls";

import {
  claimFirstWorkspace,
  consoleHeaders,
  envMandate,
  mandateOf,
  signUpWorkspace,
} from "../../../test/support/accounts";
import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../../test/support/devchain";
import { exampleLadder, examplePlan } from "../../../test/support/hedge";
import { SoftPasskey } from "../../../test/support/passkey";
import { localAgentSigner } from "../accounts/keys";
import type { StepUpAction } from "../accounts/step-up";
import type { Member } from "../accounts/store";
import { readMandatesConfig, testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import type { LadderSource } from "../wake";
import { workspaceHome } from "../workspace-home";
import { getOrders, getSettlements, getSummary, postPlan, postPolicyChangeRequest } from "./agent-api";
import { resolveToken } from "./agent-auth";
import { putSettlement } from "./executor-api";
import {
  createMandate,
  listMandates,
  listOwnerActions,
  patchMandate,
  postDeployment,
  postOwnerCall,
  startStepUp,
} from "./mandates-api";
import { createToken, revokeToken } from "./agents-api";
import { getVenueOrder, listExecutorContracts, putVenueOrder } from "./executor-orders-api";
import { saveHoldings } from "./owner-api";

const silent = { info: () => undefined, warn: () => undefined };
const ORIGIN = "http://console.test";
const SERVICE_TOKEN = "console-service-token-for-tests-0123456789";
const WAKE_URL = "https://hooks.example.test/routines/secret-path-7/run";
/** Every wake-up the env webhook was sent, for the last test: none may come from another mandate. */
const woken: WakeEvent[] = [];
const RULES: PolicyRules = {
  budgetCents: 10_000,
  maxTradeCents: 3_000,
  allowedCategories: 1 << Category.Crypto,
  approvalAboveCents: 2_000,
  dailyLossCents: 0,
  paused: false,
};
const trade = { category: Category.Crypto, outcome: "YES" as const, isBuy: true, limitPrice: 65 };

async function errorCode(response: Response): Promise<string> {
  return consoleErrorSchema.parse(await response.json()).error.code;
}

async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Several mandates per workspace on the demo chain (#95), through the console's routes: the console
 * deploys each mandate's contract from an owner key it holds, signs owner calls only after the member's
 * passkey confirms that exact call (pause excepted), and no mandate reaches another's.
 */
describe("mandates on the demo chain", () => {
  let chain: TestChain;
  let service: ConsoleService;
  let owner: Member;
  let bob: Member;
  let carol: Member;
  const keys = new Map<string, SoftPasskey>();

  function member(name: string): Member {
    const created = signUpWorkspace(service, name);
    const key = new SoftPasskey(ORIGIN);
    service.accounts.store.addPasskey(created.id, key.stored());
    keys.set(created.id, key);
    return created;
  }

  function post(who: Member, path: string, body: unknown): Request {
    return new Request(`${ORIGIN}/api/console/${path}`, {
      method: "POST",
      headers: consoleHeaders(service, who),
      body: JSON.stringify(body),
    });
  }

  function get(who: Member, path: string): Request {
    const { cookie } = consoleHeaders(service, who);
    return new Request(`${ORIGIN}/api/console/${path}`, { headers: { cookie: cookie ?? "" } });
  }

  /** The member's passkey answer to a challenge for `action`, as the browser would send it. */
  async function confirm(who: Member, action: StepUpAction) {
    const started = await startStepUp(post(who, "step-up", { action }), service);
    expect(started.status, JSON.stringify(action)).toBe(201);
    const { id, options } = (await started.json()) as { id: string; options: never };
    const key = keys.get(who.id);
    if (!key) throw new Error("no passkey");
    return { id, response: key.get(options) };
  }

  async function create(
    who: Member,
    name: string,
    rules: PolicyRules = RULES,
  ): Promise<CreatedMandateResponse> {
    const stepUp = await confirm(who, { kind: "create-mandate", name, rules });
    const response = await createMandate(post(who, "mandates", { name, rules, stepUp }), service);
    expect(response.status).toBe(201);
    return (await response.json()) as CreatedMandateResponse;
  }

  function call(who: Member, mandateId: string, ownerCall: OwnerCall, stepUp: unknown = null) {
    return postOwnerCall(post(who, `owner-calls?mandate=${mandateId}`, { call: ownerCall, stepUp }), service);
  }

  /** The mandate's agent, signing with the key the console sealed for it. */
  function agentOf(mandate: MandateView): PolicyClient {
    const agent = service.accounts.store.agentOf(mandate.id);
    if (!agent.address || !agent.sealedKey || !mandate.contract) throw new Error("no agent key or contract");
    const account = signerAccount(
      localAgentSigner(service.accounts.master, {
        id: agent.id,
        address: agent.address,
        sealedKey: agent.sealedKey,
      }),
    );
    const session = service.serverContract;
    if (!session) throw new Error("no chain");
    return new PolicyClient({
      address: mandate.contract.address,
      publicClient: session.client,
      walletClient: createWalletClient({
        chain: session.deployment.chain,
        transport: http(chain.rpcUrl),
        account,
      }),
      minMaxFeePerGas: 0n,
      receiptPollingMs: 50,
    });
  }

  function snapshotOf(mandateId: string) {
    const mandate = service.accounts.store.mandate(mandateId);
    if (!mandate) throw new Error("no mandate");
    return service.snapshot(mandate);
  }

  async function read<T>(address: Address, functionName: "user" | "agent" | "executor"): Promise<T> {
    const session = service.serverContract;
    if (!session) throw new Error("no chain");
    return await session.client.readContract({ address, abi: policyAbi, functionName });
  }

  beforeAll(async () => {
    chain = await startTestChain();
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-mandates-"));
    service = new ConsoleService(
      testConsoleConfig(dataDir, {
        serviceToken: SERVICE_TOKEN,
        mandates: { ...readMandatesConfig({}), maxPerWorkspace: 3 },
        wake: {
          target: new WakeTarget(WAKE_URL, "routine-key-for-tests"),
          offReason: null,
          dailyCap: 50,
          priceCheckMs: 60_000,
          testClock: false,
        },
      }),
      openDatabase(dataDir),
      {
        env: chain.env,
        logger: silent,
        wakeFetch: (_url, init) => {
          woken.push(wakeEventSchema.parse(JSON.parse(init.body as string)));
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      },
    );
    owner = claimFirstWorkspace(service);
    keys.set(owner.id, new SoftPasskey(ORIGIN));
    service.accounts.store.addPasskey(
      owner.id,
      keys.get(owner.id)?.stored() ?? new SoftPasskey(ORIGIN).stored(),
    );
    bob = member("Bob");
    carol = member("Carol");
    service.start();
    if (!(await service.whenSynced(15_000))) throw new Error("the console did not sync");
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("lists the workspace's own mandates, with the console as the deployer on the demo chain", async () => {
    const response = await listMandates(get(bob, "mandates"), service);
    const body = (await response.json()) as MandatesResponse;
    expect(body.deployer).toBe("server");
    expect(body.limit).toBe(3);
    expect(body.mandates.map((m) => m.id)).toEqual([mandateOf(service, bob)]);
    expect(body.mandates[0]?.contract).toBeNull();
  });

  it("creates a mandate only with a passkey confirming that name and those rules, and deploys it", async () => {
    const missing = await createMandate(
      post(bob, "mandates", { name: "Hedge", rules: RULES, stepUp: null }),
      service,
    );
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe("step_up_required");

    const looser = await confirm(bob, { kind: "create-mandate", name: "Hedge", rules: RULES });
    const swapped = await createMandate(
      post(bob, "mandates", { name: "Hedge", rules: { ...RULES, maxTradeCents: 10_000 }, stepUp: looser }),
      service,
    );
    expect(swapped.status).toBe(401);
    expect(await errorCode(swapped)).toBe("step_up_refused");

    const created = await create(bob, "Hedge");
    expect(created.token.token).toMatch(/^mdt_/);
    expect(created.deployProblem).toBeNull();
    expect(created.mandate.ownerSigner).toBe("console");
    const contract = created.mandate.contract;
    if (!contract) throw new Error("no contract");
    const ownerKey = service.accounts.store.ownerKeyOf(created.mandate.id);
    expect(await read<Address>(contract.address, "user")).toBe(ownerKey?.address);
    expect(await read<Address>(contract.address, "agent")).toBe(created.mandate.agent.address);
    expect(await read<Address>(contract.address, "executor")).toBe(chain.executor.account?.address);
    await until(() => snapshotOf(created.mandate.id).chain?.rules !== null, "the new mandate's rules");
    expect(snapshotOf(created.mandate.id).chain?.rules).toEqual(RULES);
    // The first rules are an owner action like any other: recorded with the passkey that confirmed them.
    const recorded = service.accounts.store.ownerActions(created.mandate.id, 10);
    expect(recorded.map((a) => a.functionName).sort()).toEqual(["mandate.create", "setPolicy"]);
    for (const action of recorded) {
      expect(action).toMatchObject({ status: "sent", memberName: "Bob", credentialId: keys.get(bob.id)?.id });
    }
  });

  it("deploys a sign-up's first mandate on a session alone, with no rules: it allows nothing yet", async () => {
    const first = mandateOf(service, carol);
    const response = await postDeployment(
      post(carol, `mandates/${first}/deployment`, { txHash: null }),
      service,
      {
        mandateId: first,
      },
    );
    expect(response.status).toBe(200);
    const view = (await response.json()) as MandateView;
    expect(view.deployment).toBe("server");
    await until(() => snapshotOf(first).chain !== null, "carol's first mandate");
    expect(snapshotOf(first).chain?.rules).toBeNull();
    // Another workspace's member cannot deploy it, nor learn it exists.
    const foreign = await postDeployment(
      post(bob, `mandates/${first}/deployment`, { txHash: null }),
      service,
      {
        mandateId: first,
      },
    );
    expect(foreign.status).toBe(404);
  });

  it("never deploys or attaches a second contract to a mandate that has one, on either branch", async () => {
    const someTx = `0x${"ab".repeat(32)}`;
    function redeploy(who: Member, mandateId: string, txHash: string | null) {
      return postDeployment(post(who, `mandates/${mandateId}/deployment`, { txHash }), service, {
        mandateId,
      });
    }
    // The first workspace's env mandate follows the server's own contract: the admin's session can neither
    // deploy it a contract of its own nor attach a wallet's.
    const env = envMandate(service);
    const rowBefore = service.accounts.store.mandate(env.id);
    const serverAddress = service.serverContract?.deployment.address;
    expect(serverAddress).toBeDefined();
    expect(snapshotOf(env.id).contract?.address).toBe(serverAddress);
    for (const txHash of [null, someTx]) {
      const refused = await redeploy(owner, env.id, txHash);
      expect(refused.status, String(txHash)).toBe(409);
      expect(await errorCode(refused)).toBe("has_contract");
    }
    expect(service.accounts.store.mandate(env.id)).toEqual(rowBefore);
    expect(service.accounts.store.ownerKeyOf(env.id)).toBeNull();
    expect(snapshotOf(env.id).contract?.address).toBe(serverAddress);
    expect(snapshotOf(env.id).contract?.ownerSigner).toBe("wallet");

    // A mandate the console deployed keeps its contract and its owner key.
    const carols = mandateOf(service, carol);
    const deployed = service.accounts.store.mandate(carols);
    const key = service.accounts.store.ownerKeyOf(carols);
    expect(deployed?.deployment).toBe("server");
    for (const txHash of [null, someTx]) {
      const refused = await redeploy(carol, carols, txHash);
      expect(refused.status, String(txHash)).toBe(409);
      expect(await errorCode(refused)).toBe("has_contract");
    }
    expect(service.accounts.store.mandate(carols)).toEqual(deployed);
    expect(service.accounts.store.ownerKeyOf(carols)).toEqual(key);
    expect(snapshotOf(carols).contract?.address.toLowerCase()).toBe(
      deployed?.contract?.address.toLowerCase(),
    );
  });

  it("approves only with the passkey confirming that intent on that mandate; pauses on the session alone", async () => {
    const created = await create(bob, "Approvals");
    const mandateId = created.mandate.id;
    const agent = agentOf(created.mandate);
    const held = await agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 2_500 });
    await until(
      () => snapshotOf(mandateId).chain?.intents.some((i) => i.id === held.intentId) ?? false,
      "the held intent",
    );
    const approveCall: OwnerCall = { functionName: "approveIntent", intentId: held.intentId };

    const bare = await call(bob, mandateId, approveCall);
    expect(bare.status).toBe(422);
    expect(await errorCode(bare)).toBe("step_up_required");

    const otherIntent = await confirm(bob, {
      kind: "owner-call",
      mandateId,
      call: { functionName: "approveIntent", intentId: held.intentId + 1 },
    });
    expect(await errorCode(await call(bob, mandateId, approveCall, otherIntent))).toBe("step_up_refused");

    const otherMandate = mandateOf(service, bob);
    const elsewhere = await confirm(bob, { kind: "owner-call", mandateId, call: approveCall });
    const moved = await call(bob, otherMandate, approveCall, elsewhere);
    expect(moved.status).toBe(409); // that mandate has no console-held contract to act on

    const confirmed = await confirm(bob, { kind: "owner-call", mandateId, call: approveCall });
    const approved = await call(bob, mandateId, approveCall, confirmed);
    expect(approved.status).toBe(201);
    expect((await agent.getIntent(held.intentId))?.status).toBe("approved");
    // The same confirmation, replayed, is refused.
    expect(await errorCode(await call(bob, mandateId, approveCall, confirmed))).toBe("step_up_expired");

    const paused = await call(bob, mandateId, { functionName: "setPaused", paused: true });
    expect(paused.status).toBe(201);
    expect((await agent.getRules()).paused).toBe(true);
    const unpause = await call(bob, mandateId, { functionName: "setPaused", paused: false });
    expect(await errorCode(unpause)).toBe("step_up_required");
    const unpaused = await call(
      bob,
      mandateId,
      { functionName: "setPaused", paused: false },
      await confirm(bob, {
        kind: "owner-call",
        mandateId,
        call: { functionName: "setPaused", paused: false },
      }),
    );
    expect(unpaused.status).toBe(201);

    // The audit trail names who authorised each call, and with which passkey.
    const audit = (await (
      await listOwnerActions(get(bob, `owner-actions?mandate=${mandateId}`), service)
    ).json()) as {
      actions: { functionName: string; memberName: string; credentialId: string | null; status: string }[];
    };
    const sent = audit.actions.filter((a) => a.status === "sent");
    expect(sent.map((a) => a.functionName).sort()).toEqual([
      "approveIntent",
      "mandate.create",
      "setPaused",
      "setPaused",
      "setPolicy",
    ]);
    const passkey = keys.get(bob.id)?.id;
    // Every action but the pause was confirmed with Bob's passkey; the pause was the session's alone.
    expect(sent.filter((a) => a.credentialId === null).map((a) => a.functionName)).toEqual(["setPaused"]);
    expect(sent.filter((a) => a.credentialId !== null).every((a) => a.credentialId === passkey)).toBe(true);
    expect(sent.every((a) => a.memberName === "Bob")).toBe(true);
  });

  it("sends two approvals confirmed at the same moment, one after the other, without a nonce race", async () => {
    const mandate = service.accounts.store.mandates(bob.workspaceId).find((m) => m.name === "Approvals");
    if (!mandate?.contract) throw new Error("no mandate");
    const views = (await (await listMandates(get(bob, "mandates"), service)).json()) as MandatesResponse;
    const view = views.mandates.find((m) => m.id === mandate.id);
    if (!view) throw new Error("no view");
    const agent = agentOf(view);
    const one = await agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 2_100 });
    const two = await agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 2_200 });
    const calls = [one, two].map((held): OwnerCall => ({
      functionName: "approveIntent",
      intentId: held.intentId,
    }));
    const confirmations = await Promise.all(
      calls.map((c) => confirm(bob, { kind: "owner-call", mandateId: mandate.id, call: c })),
    );
    const responses = await Promise.all(calls.map((c, i) => call(bob, mandate.id, c, confirmations[i])));
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect((await agent.getIntent(one.intentId))?.status).toBe("approved");
    expect((await agent.getIntent(two.intentId))?.status).toBe("approved");
  });

  it("takes a passkey, never a wallet signature or a bare session, for offchain owner requests", async () => {
    const mandate = service.accounts.store.mandates(bob.workspaceId).find((m) => m.name === "Approvals");
    if (!mandate) throw new Error("no mandate");
    const payload = { holdings: [{ asset: "BTC", quantity: "0.5" }] };
    const path = `holdings?mandate=${mandate.id}`;
    const save = (body: unknown) =>
      saveHoldings(
        new Request(`${ORIGIN}/api/console/${path}`, {
          method: "PUT",
          headers: consoleHeaders(service, bob),
          body: JSON.stringify(body),
        }),
        service,
      );
    const signed = await save({
      payload,
      auth: { issuedAt: new Date().toISOString(), nonce: `0x${"1".repeat(32)}`, signature: "0x00" },
    });
    expect(await errorCode(signed)).toBe("step_up_required");
    const otherPayload = await confirm(bob, {
      kind: "owner-request",
      mandateId: mandate.id,
      request: { action: "holdings.save", payload: { holdings: [{ asset: "BTC", quantity: "9" }] } },
    });
    expect(await errorCode(await save({ payload, stepUp: otherPayload }))).toBe("step_up_refused");
    const confirmed = await confirm(bob, {
      kind: "owner-request",
      mandateId: mandate.id,
      request: { action: "holdings.save", payload },
    });
    const saved = await save({ payload, stepUp: confirmed });
    expect(saved.status).toBe(200);
    expect(service.offchain.holdings(mandate.id).holdings).toEqual(payload.holdings);
    // Nothing reached Bob's other mandate.
    expect(service.offchain.holdings(mandateOf(service, bob)).holdings).toEqual([]);
  });

  it("refuses owner calls on another workspace's mandate, and on the server's own contract", async () => {
    const bobs = service.accounts.store.mandates(bob.workspaceId).find((m) => m.deployment === "server");
    if (!bobs) throw new Error("bob has no deployed mandate");
    const pause = await call(owner, bobs.id, { functionName: "setPaused", paused: true });
    expect(pause.status).toBe(404);
    const startForeign = await startStepUp(
      post(owner, "step-up", {
        action: {
          kind: "owner-call",
          mandateId: bobs.id,
          call: { functionName: "approveIntent", intentId: 0 },
        },
      }),
      service,
    );
    expect(startForeign.status).toBe(404);
    const env = envMandate(service).id;
    const own = await call(owner, env, { functionName: "setPaused", paused: true });
    expect(await errorCode(own)).toBe("not_console_owned");
  });

  it("keeps two mandates' agents apart when they act at the same moment", async () => {
    const left = await create(carol, "Left");
    const leftAgent = agentOf(left.mandate);
    const bobsApprovals = service.accounts.store
      .mandates(bob.workspaceId)
      .find((m) => m.name === "Approvals");
    if (!bobsApprovals) throw new Error("no mandate");
    const rightView = (await (await listMandates(get(bob, "mandates"), service)).json()) as MandatesResponse;
    const right = rightView.mandates.find((m) => m.id === bobsApprovals.id);
    if (!right) throw new Error("no view");
    const rightAgent = agentOf(right);
    // From the contract: the follower may not have read an earlier test's intents yet.
    const before = (await rightAgent.getSnapshot()).committedCents;
    const [a, b] = await Promise.all([
      leftAgent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_500 }),
      rightAgent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_200 }),
    ]);
    await until(
      () => snapshotOf(left.mandate.id).chain?.intents.some((i) => i.id === a.intentId) ?? false,
      "left",
    );
    await until(() => snapshotOf(right.id).chain?.intents.some((i) => i.id === b.intentId) ?? false, "right");
    const leftChain = snapshotOf(left.mandate.id).chain;
    const rightChain = snapshotOf(right.id).chain;
    expect(leftChain?.intents.map((i) => i.amountCents)).toEqual([1_500]);
    expect(leftChain?.committedCents).toBe(1_500);
    expect(rightChain?.committedCents).toBe(before + 1_200);
    expect(rightChain?.intents.some((i) => i.amountCents === 1_500)).toBe(false);
    // Each agent can only write to its own contract.
    const crossed = new PolicyClient({
      address: left.mandate.contract?.address ?? "0x",
      publicClient: rightAgent.publicClient,
      walletClient: rightAgent.walletClient,
      minMaxFeePerGas: 0n,
      receiptPollingMs: 50,
    });
    await expect(
      crossed.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 100 }),
    ).rejects.toThrow();
  });

  it("creates an agent token only with a passkey confirming that agent and that name; revokes on a session", async () => {
    const agentId = service.accounts.store.agentOf(mandateOf(service, bob)).id;
    const path = `agents/${agentId}/tokens`;
    const create = (body: unknown) => createToken(post(bob, path, body), service, { agentId });

    const bare = await create({ name: "Laptop", stepUp: null });
    expect(await errorCode(bare)).toBe("step_up_required");
    const renamed = await confirm(bob, { kind: "create-token", agentId, name: "Something else" });
    expect(await errorCode(await create({ name: "Laptop", stepUp: renamed }))).toBe("step_up_refused");
    const otherAgent = service.accounts.store.agentOf(
      service.accounts.store.mandates(bob.workspaceId).find((m) => m.name === "Hedge")?.id ?? "",
    ).id;
    const elsewhere = await confirm(bob, { kind: "create-token", agentId: otherAgent, name: "Laptop" });
    expect(await errorCode(await create({ name: "Laptop", stepUp: elsewhere }))).toBe("step_up_refused");

    // Another workspace's agent: no challenge, and no token, the same as an agent that does not exist.
    const foreign = await startStepUp(
      post(carol, "step-up", { action: { kind: "create-token", agentId, name: "Laptop" } }),
      service,
    );
    expect(foreign.status).toBe(404);

    const created = await create({
      name: "Laptop",
      stepUp: await confirm(bob, { kind: "create-token", agentId, name: "Laptop" }),
    });
    expect(created.status).toBe(201);
    const { view } = (await created.json()) as { view: { id: string } };
    const audit = service.accounts.store.ownerActions(mandateOf(service, bob), 10);
    expect(audit[0]).toMatchObject({ functionName: "token.create", credentialId: keys.get(bob.id)?.id });

    const revoked = await revokeToken(
      new Request(`${ORIGIN}/api/console/${path}/${view.id}`, {
        method: "DELETE",
        headers: consoleHeaders(service, bob),
      }),
      service,
      { agentId, tokenId: view.id },
    );
    expect(revoked.status).toBe(200);
  });

  it("lets one executor key find and fill every mandate's contract, two approvals at the same moment", async () => {
    const executorWallet = chain.executor.walletClient;
    if (!executorWallet) throw new Error("no executor wallet");
    const chainId = chain.executor.publicClient.chain.id;
    const consoleFetch = (input: string) => listExecutorContracts(new Request(input), service, {});
    const discover = consoleContractDiscovery({
      consoleUrl: ORIGIN,
      chainId,
      signMessage: (message) => executorWallet.signMessage({ account: executorWallet.account, message }),
      fetch: consoleFetch,
    });

    // The listing names the server's contract and every mandate contract that names this executor.
    const listed = await discover();
    const deployed = service.accounts.store.contractMandates().map((m) => m.contract?.address.toLowerCase());
    expect(listed.map((c) => c.policy).sort()).toEqual([chain.address.toLowerCase(), ...deployed].sort());
    // Another key learns nothing; nor does a stale or a malformed request.
    const outsiderWallet = chain.outsider.walletClient;
    if (!outsiderWallet) throw new Error("no outsider wallet");
    const outsider = consoleContractDiscovery({
      consoleUrl: ORIGIN,
      chainId,
      signMessage: (message) => outsiderWallet.signMessage({ account: outsiderWallet.account, message }),
      fetch: consoleFetch,
    });
    expect(await outsider()).toEqual([]);
    const stale = consoleContractDiscovery({
      consoleUrl: ORIGIN,
      chainId,
      signMessage: (message) => executorWallet.signMessage({ account: executorWallet.account, message }),
      fetch: consoleFetch,
      now: () => Date.now() - 10 * 60_000,
    });
    await expect(stale()).rejects.toThrow(/401/);

    const left = service.accounts.store.mandates(bob.workspaceId).find((m) => m.name === "Hedge");
    const right = service.accounts.store.mandates(carol.workspaceId).find((m) => m.name === "Left");
    if (!left?.contract || !right?.contract) throw new Error("no contracts");
    const views = [
      ...((await (await listMandates(get(bob, "mandates"), service)).json()) as MandatesResponse).mandates,
      ...((await (await listMandates(get(carol, "mandates"), service)).json()) as MandatesResponse).mandates,
    ];
    const agentFor = (id: string) => {
      const view = views.find((m) => m.id === id);
      if (!view) throw new Error("no view");
      return agentOf(view);
    };

    const lane = new WriteLane();
    const placed: string[] = [];
    const fleet = startExecutorFleet({
      discover,
      intervalMs: 60_000,
      log: () => undefined,
      start: (contract) =>
        Promise.resolve(
          startExecutor({
            client: new PolicyClient({
              address: contract.policy as Address,
              publicClient: chain.executor.publicClient,
              walletClient: executorWallet,
              lane,
            }),
            venue: {
              kind: "simulated",
              categoryOf: () => Promise.resolve(Category.Crypto),
              placeOrder: (order) => {
                placed.push(`${contract.policy}:${String(order.intentId)}`);
                return Promise.resolve({
                  status: "placed",
                  placed: { order, venueOrderId: `fake-${String(order.intentId)}` },
                });
              },
              readFill: (order) =>
                Promise.resolve({ state: "closed", filledCents: order.order.amountCents, detail: "filled" }),
              positionOutcome: () =>
                Promise.resolve({ status: "open", expiresAt: "2026-11-20T22:00:00.000Z" }),
            },
            fromBlock: BigInt(contract.deployBlock),
            fillDelayMs: 0,
            pollingIntervalMs: 50,
            settleIntervalMs: 60_000,
            log: () => undefined,
          }),
        ),
    });
    try {
      await fleet.refresh();
      expect(fleet.serving()).toEqual(listed.map((c) => `${String(c.chainId)}:${c.policy}`).sort());
      const [a, b] = await Promise.all([
        agentFor(left.id).proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_000 }),
        agentFor(right.id).proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_100 }),
      ]);
      const leftAgent = agentFor(left.id);
      const rightAgent = agentFor(right.id);
      await until(() => placed.length >= 2, "orders placed");
      const deadline = Date.now() + 15_000;
      let statuses: (string | undefined)[] = [];
      while (Date.now() < deadline) {
        statuses = [
          (await leftAgent.getIntent(a.intentId))?.status,
          (await rightAgent.getIntent(b.intentId))?.status,
        ];
        if (statuses.every((s) => s === "executed")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(statuses).toEqual(["executed", "executed"]);
      // Each order went to its own contract, once. The executor also filled what earlier tests approved
      // on other contracts, with the same intent ids on several contracts: each placed apart, never twice.
      const mine = [
        `${left.contract.address.toLowerCase()}:${String(a.intentId)}`,
        `${right.contract.address.toLowerCase()}:${String(b.intentId)}`,
      ];
      for (const key of mine) expect(placed.filter((p) => p === key)).toHaveLength(1);
      expect(new Set(placed).size).toBe(placed.length);
      const served = new Set(listed.map((c) => c.policy));
      expect(placed.every((p) => served.has(p.split(":")[0] ?? ""))).toBe(true);
    } finally {
      fleet.stop();
    }
  });

  it("keeps two mandates' journals, settlements, digests and Home rows apart, with the same intent id on each", async () => {
    const executorWallet = chain.executor.walletClient;
    if (!executorWallet) throw new Error("no executor wallet");
    const chainId = chain.executor.publicClient.chain.id;
    const twinA = await create(owner, "Twin A", { ...RULES, approvalAboveCents: 1_500 });
    const twinB = await create(owner, "Twin B", { ...RULES, approvalAboveCents: 1_500 });
    const [contractA, contractB] = [twinA.mandate.contract, twinB.mandate.contract];
    if (!contractA || !contractB) throw new Error("no contracts");

    // Each real token resolves to its own agent; agent routes then name no mandate at all.
    const agentIdOf = async (token: string) => {
      const response = await resolveToken(
        new Request(`${ORIGIN}${CONSOLE_AGENT_ROUTES.resolveToken}`, {
          method: "POST",
          headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ tokenHash: hashAgentToken(token), legacy: false }),
        }),
        service,
      );
      expect(response.status).toBe(200);
      return resolveTokenResponseSchema.parse(await response.json());
    };
    const resolvedA = await agentIdOf(twinA.token.token);
    const resolvedB = await agentIdOf(twinB.token.token);
    expect([resolvedA.mandateId, resolvedB.mandateId]).toEqual([twinA.mandate.id, twinB.mandate.id]);
    const asAgent = (agentId: string, method: string, path: string, body?: unknown) =>
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          [AGENT_ID_HEADER]: agentId,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // Intent 0 on both contracts, at the same moment; B's waits for the owner.
    const [a, b] = await Promise.all([
      agentOf(twinA.mandate).proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_300 }),
      agentOf(twinB.mandate).proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_400 }),
    ]);
    const held = await agentOf(twinB.mandate).proposeTrade({
      ...trade,
      market: BTC_ABOVE_65K,
      amountCents: 2_000,
    });
    expect([a.intentId, b.intentId, held.intentId]).toEqual([0, 0, 1]);
    await until(() => snapshotOf(twinA.mandate.id).chain?.intents.length === 1, "A's intent");
    await until(() => snapshotOf(twinB.mandate.id).chain?.intents.length === 2, "B's intents");

    // The executor's journal: one record per contract for intent 0, each read back from its own contract.
    const executorFetch = async (input: string, init: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const request = new Request(url, init);
      const order = /^\/api\/executor\/v1\/orders\/([^/]+)$/.exec(url.pathname);
      if (order?.[1]) {
        const params = { intentId: decodeURIComponent(order[1]) };
        return request.method === "PUT"
          ? putVenueOrder(request, service, params)
          : getVenueOrder(request, service, params);
      }
      const settlement = /^\/api\/executor\/v1\/settlements\/([^/]+)$/.exec(url.pathname);
      if (settlement?.[1]) return putSettlement(request, service, { intentId: settlement[1] });
      return new Response("<html>Not found</html>", { status: 404 });
    };
    const sign = (hash: `0x${string}`) =>
      executorWallet.signMessage({ account: executorWallet.account, message: { raw: hash } });
    const journalOf = (policy: string) =>
      consoleOrderJournal({
        consoleUrl: ORIGIN,
        sign,
        fetch: executorFetch,
        deployment: { chainId, policy },
        retryDelaysMs: [50, 100, 200, 400, 800],
      });
    const policyA = contractA.address.toLowerCase() as `0x${string}`;
    const policyB = contractB.address.toLowerCase() as `0x${string}`;
    // Each id is made from its own contract and real deploy block, as the executor's fleet makes it.
    const deploymentOf = async (mandateId: string) => {
      const contract = service.accounts.store.mandate(mandateId)?.contract;
      if (!contract) throw new Error("no contract");
      return venueDeployment(
        { address: contract.address, publicClient: chain.executor.publicClient },
        BigInt(contract.deployBlock),
      );
    };
    const [deploymentA, deploymentB] = [
      await deploymentOf(twinA.mandate.id),
      await deploymentOf(twinB.mandate.id),
    ];
    const deploymentFor = (policy: `0x${string}`): OrderIdDeployment =>
      policy === policyA ? deploymentA : deploymentB;
    const recordFor = (policy: `0x${string}`, cents: number): VenueOrderRecord => ({
      kind: "venue-order",
      version: 1,
      chainId,
      policy,
      intentId: 0,
      revision: 1,
      venue: "gemini",
      environment: "sandbox",
      clientOrderId: clientOrderIdFor(deploymentFor(policy), 0),
      market: BTC_ABOVE_65K,
      side: "buy",
      outcome: "YES",
      quantityHundredths: contractsBought(cents, trade.limitPrice),
      limitPrice: trade.limitPrice,
      state: "placing",
      venueOrderId: null,
      filledHundredths: 0,
      filledCents: 0,
      detail: null,
      placedAt: "2026-11-17T08:00:00.000Z",
      updatedAt: "2026-11-17T08:00:00.000Z",
    });
    await journalOf(policyA).put(recordFor(policyA, 1_300));
    expect(await journalOf(policyB).get(0)).toBeNull();
    await journalOf(policyB).put(recordFor(policyB, 1_400));
    const [readA, readB] = [await journalOf(policyA).get(0), await journalOf(policyB).get(0)];
    expect(readA?.policy).toBe(policyA);
    expect(readB?.policy).toBe(policyB);
    expect(readA?.clientOrderId).not.toBe(readB?.clientOrderId);

    // Both fill; each settlement goes through the executor's real sink to its own mandate.
    const lane = new WriteLane();
    const executorOn = (address: Address) =>
      new PolicyClient({
        address,
        publicClient: chain.executor.publicClient,
        walletClient: executorWallet,
        lane,
        minMaxFeePerGas: 0n,
        receiptPollingMs: 50,
      });
    await executorOn(contractA.address).recordResult({
      intentId: 0,
      filled: true,
      filledCents: 1_300,
      pnlCents: 0,
    });
    await executorOn(contractB.address).recordResult({
      intentId: 0,
      filled: true,
      filledCents: 1_400,
      pnlCents: 0,
    });
    await until(
      () => snapshotOf(twinA.mandate.id).chain?.intents[0]?.status === "executed",
      "A's intent executed",
    );
    await until(
      () => snapshotOf(twinB.mandate.id).chain?.intents.find((i) => i.id === 0)?.status === "executed",
      "B's intent executed",
    );
    // A's fill paid an estimated fee (#113); B's paid none. Each mandate's records carry only its own.
    const settlementFor = (policy: `0x${string}`, costCents: number, feeCents?: number): Settlement => {
      const contracts = contractsBought(costCents, trade.limitPrice);
      return {
        version: 1,
        chainId,
        policy,
        intentId: 0,
        market: BTC_ABOVE_65K,
        eventTicker: "BTC2611202200",
        strikeCents: 6_500_000,
        expiresAt: "2026-11-20T22:00:00.000Z",
        outcome: "YES",
        costCents,
        limitPrice: trade.limitPrice,
        contractsHundredths: contracts,
        resolution: "yes",
        payoutCents: contracts,
        ...(feeCents === undefined ? {} : { feeCents }),
        pnlCents: contracts - costCents - (feeCents ?? 0),
        settlementValue: "65100.5",
        resolvedAt: "2026-11-20T22:00:08.232Z",
        venue: "gemini",
      };
    };
    const sink = consoleSettlementSink({ consoleUrl: ORIGIN, fetch: executorFetch });
    for (const document of [settlementFor(policyA, 1_300, 12), settlementFor(policyB, 1_400)]) {
      const signature = await executorWallet.signMessage({
        account: executorWallet.account,
        message: settlementMessage(hashSettlement(document)),
      });
      expect((await sink.record({ document, signature })).status).toBe("stored");
    }
    const settlementsOf = async (agentId: string) => {
      const response = await getSettlements(
        asAgent(agentId, "GET", CONSOLE_AGENT_ROUTES.settlements),
        service,
      );
      expect(response.status).toBe(200);
      return settlementsResponseSchema.parse(await response.json()).settlements;
    };
    expect((await settlementsOf(resolvedA.agentId)).map((s) => s.document.costCents)).toEqual([1_300]);
    expect((await settlementsOf(resolvedB.agentId)).map((s) => s.document.costCents)).toEqual([1_400]);
    // Each agent's orders (#117) are its own mandate's: intent 0 on both, each at its own size.
    const ordersOf = async (agentId: string) => {
      const response = await getOrders(asAgent(agentId, "GET", CONSOLE_AGENT_ROUTES.orders), service);
      expect(response.status).toBe(200);
      return ordersResponseSchema.parse(await response.json()).orders;
    };
    expect((await ordersOf(resolvedA.agentId)).map((o) => [o.intentId, o.quantityHundredths])).toEqual([
      [0, contractsBought(1_300, trade.limitPrice)],
    ]);
    expect((await ordersOf(resolvedB.agentId)).map((o) => [o.intentId, o.quantityHundredths])).toEqual([
      [0, contractsBought(1_400, trade.limitPrice)],
    ]);
    expect((await settlementsOf(resolvedA.agentId)).map((s) => s.document.feeCents)).toEqual([12]);
    expect((await settlementsOf(resolvedB.agentId)).map((s) => s.document.feeCents)).toEqual([undefined]);
    // The owner's views sum one result per position, each mandate's own: A's net is after its fee.
    const feesOf = (id: string) =>
      Object.values(snapshotOf(id).chain?.settlements ?? {}).map((s) =>
        s.status === "verified" ? (s.document.feeCents ?? null) : "tampered",
      );
    expect(feesOf(twinA.mandate.id)).toEqual([12]);
    expect(feesOf(twinB.mandate.id)).toEqual([null]);

    // The digest: only A filed a change request and a goal; B's summary shows neither, and each link
    // opens its own mandate.
    const expiry = new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/T.*/, "T22:00:00.000Z");
    const plan = examplePlan(expiry);
    const ladder: LadderSource = () => Promise.resolve({ ok: true, ladder: exampleLadder(expiry) });
    const goal = await postPlan(
      asAgent(resolvedA.agentId, "POST", CONSOLE_AGENT_ROUTES.plans, {
        planId: plan.planId,
        asset: "BTC",
        requestText: "Protect my 0.05 BTC below $64,000 this week.",
        createdAt: new Date().toISOString(),
        plan,
      }),
      service,
    );
    expect(goal.status).toBe(201);
    const filed = await postPolicyChangeRequest(
      asAgent(resolvedA.agentId, "POST", CONSOLE_AGENT_ROUTES.policyChangeRequests, {
        agentAddress: twinA.mandate.agent.address,
        proposed: { maxTradeCents: 3_500 },
        reason: "The top rung costs more than the max trade size.",
      }),
      service,
    );
    expect(filed.status).toBe(201);
    const summaryOf = async (agentId: string) => {
      const response = await getSummary(
        asAgent(agentId, "GET", CONSOLE_AGENT_ROUTES.summary),
        service,
        ladder,
      );
      expect(response.status).toBe(200);
      return summaryResponseSchema.parse(await response.json());
    };
    const [summaryA, summaryB] = [await summaryOf(resolvedA.agentId), await summaryOf(resolvedB.agentId)];
    expect(summaryA.consoleUrl).toBe(`${service.config.publicUrl}/m/${twinA.mandate.id}`);
    expect(summaryB.consoleUrl).toBe(`${service.config.publicUrl}/m/${twinB.mandate.id}`);
    expect(summaryA.changeRequests).toHaveLength(1);
    expect(summaryB.changeRequests).toEqual([]);
    expect(summaryA.cover.map((c) => c.planId)).toEqual([plan.planId]);
    expect(summaryB.cover).toEqual([]);

    // Home: one row per mandate, each with its own waiting, spend and cover.
    const access = service.accounts.access(service.accounts.openSession(owner));
    if (!access) throw new Error("no access");
    const home = await workspaceHome(access, service, ladder);
    const rowOf = (id: string) => home.mandates.find((row) => row.mandate.id === id);
    expect(home.mandates.map((row) => row.mandate.id)).toEqual(
      service.accounts.store.mandates(owner.workspaceId).map((m) => m.id),
    );
    expect(rowOf(twinA.mandate.id)).toMatchObject({ waiting: 1, committedCents: 1_300 });
    expect(rowOf(twinA.mandate.id)?.cover.goals).toBe(1);
    expect(rowOf(twinB.mandate.id)).toMatchObject({ waiting: 1, committedCents: 1_400 });
    expect(rowOf(twinB.mandate.id)?.cover.goals).toBe(0);
    expect(home.canCreate).toBe(false);
    // Nothing of another workspace's mandates is on this Home.
    const others = new Set(
      [bob, carol].flatMap((m) => service.accounts.store.mandates(m.workspaceId).map((x) => x.id)),
    );
    expect(home.mandates.some((row) => others.has(row.mandate.id))).toBe(false);

    // A market that never answers costs Home that goal's cover, not the page: it answers after the wait.
    const started = Date.now();
    const stalled = await workspaceHome(access, service, () => new Promise(() => undefined), 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stalled.mandates.find((row) => row.mandate.id === twinA.mandate.id)?.cover).toMatchObject({
      goals: 1,
      unavailable: 1,
    });
    expect(stalled.mandates.find((row) => row.mandate.id === twinA.mandate.id)?.waiting).toBe(1);
  });

  it("refuses a mandate past the workspace's cap, with what to do about it", async () => {
    // Carol has her first mandate and "Left"; the cap is 3.
    await create(carol, "Third");
    const name = "Fourth";
    const stepUp = await confirm(carol, { kind: "create-mandate", name, rules: RULES });
    const refused = await createMandate(post(carol, "mandates", { name, rules: RULES, stepUp }), service);
    expect(refused.status).toBe(409);
    const body = consoleErrorSchema.parse(await refused.json());
    expect(body.error.code).toBe("mandate_limit");
    expect(body.error.message).toContain("CONSOLE_MANDATES_PER_WORKSPACE");
    expect(service.accounts.store.mandates(carol.workspaceId)).toHaveLength(3);
  });

  it("sends the env webhook only what the first mandate's contract did (#112 adds one per agent)", async () => {
    // Bob paused his "Approvals" mandate, and the twins' ladders settled: none of it may wake the env routine.
    const env = envMandate(service);
    await service.wake.settled();
    expect(woken.filter((w) => w.kind === "mandate_changed" || w.kind === "ladder_settled")).toEqual([]);
    for (const wake of woken) expect(wake.link).toContain(`/m/${env.id}`);
    expect(service.snapshot(env).wake.enabled).toBe(true);
    for (const mandate of service.accounts.store.contractMandates()) {
      expect(service.snapshot(mandate).wake).toMatchObject({ enabled: false, recent: [] });
    }
  });

  it("renames a mandate on an admin's session, records it, and the agent's next lookup names it so", async () => {
    const hedge = service.accounts.store.mandates(bob.workspaceId).find((m) => m.name === "Hedge");
    if (!hedge) throw new Error("bob has no Hedge mandate");
    function rename(who: Member, mandateId: string, name: unknown) {
      return patchMandate(
        new Request(`${ORIGIN}/api/console/mandates/${mandateId}`, {
          method: "PATCH",
          headers: consoleHeaders(service, who),
          body: JSON.stringify({ name }),
        }),
        service,
        { mandateId },
      );
    }
    const { token } = service.accounts.store.createToken(service.accounts.store.agentOf(hedge.id).id, "Bot");
    async function resolvedName(): Promise<string> {
      const response = await resolveToken(
        new Request(`${ORIGIN}${CONSOLE_AGENT_ROUTES.resolveToken}`, {
          method: "POST",
          headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ tokenHash: hashAgentToken(token), legacy: false }),
        }),
        service,
      );
      return resolveTokenResponseSchema.parse(await response.json()).mandate.name;
    }
    expect(await resolvedName()).toBe("Hedge");
    const actionsBefore = service.accounts.store.ownerActions(hedge.id, 100).length;

    // A passkey prompt confirms the mandate id and its contract, never its name: one answered before the
    // rename still signs the same call after it.
    const setPolicy: OwnerCall = { functionName: "setPolicy", rules: RULES };
    const stepUp = await confirm(bob, { kind: "owner-call", mandateId: hedge.id, call: setPolicy });

    // Another workspace's member cannot rename it, nor learn it exists; a blank or unprintable name is refused.
    expect((await rename(carol, hedge.id, "Mine now")).status).toBe(404);
    for (const bad of ["   ", "x".repeat(61), "Tab\there", 7]) {
      const refused = await rename(bob, hedge.id, bad);
      expect(refused.status, JSON.stringify(bad)).toBe(422);
    }
    expect(service.accounts.store.mandate(hedge.id)?.name).toBe("Hedge");

    const renamed = await rename(bob, hedge.id, "  Hedge BTC  ");
    expect(renamed.status).toBe(200);
    const view = (await renamed.json()) as MandateView;
    expect(view).toMatchObject({ id: hedge.id, name: "Hedge BTC", deployment: "server" });
    expect(view.contract?.address.toLowerCase()).toBe(hedge.contract?.address.toLowerCase());
    // The same name again changes and records nothing.
    expect((await rename(bob, hedge.id, "Hedge BTC")).status).toBe(200);

    const recorded = service.accounts.store.ownerActions(hedge.id, 100);
    expect(recorded).toHaveLength(actionsBefore + 1);
    expect(recorded[0]).toMatchObject({
      functionName: "mandate.rename",
      memberName: "Bob",
      credentialId: null,
      status: "sent",
      detail: 'from "Hedge" to "Hedge BTC"',
    });
    const listed = await listOwnerActions(get(bob, `owner-actions?mandate=${hedge.id}`), service);
    const { actions } = (await listed.json()) as { actions: { functionName: string }[] };
    expect(actions[0]?.functionName).toBe("mandate.rename");

    // The agent's next token lookup names the new name: the MCP server caches nothing, so whoami does too.
    expect(await resolvedName()).toBe("Hedge BTC");
    const listedMandates = (await (
      await listMandates(get(bob, "mandates"), service)
    ).json()) as MandatesResponse;
    expect(listedMandates.mandates.find((m) => m.id === hedge.id)?.name).toBe("Hedge BTC");

    const signed = await call(bob, hedge.id, setPolicy, stepUp);
    expect(signed.status).toBe(201);
  });
});
