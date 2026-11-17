import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Category,
  PolicyClient,
  WriteLane,
  type PolicyRules,
  consoleErrorSchema,
  policyAbi,
  signerAccount,
} from "@mandate/shared";
import { consoleContractDiscovery, startExecutor, startExecutorFleet } from "@mandate/devchain";
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
import { SoftPasskey } from "../../../test/support/passkey";
import { localAgentSigner } from "../accounts/keys";
import type { StepUpAction } from "../accounts/step-up";
import type { Member } from "../accounts/store";
import { readMandatesConfig, testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import {
  createMandate,
  listMandates,
  listOwnerActions,
  postDeployment,
  postOwnerCall,
  startStepUp,
} from "./mandates-api";
import { createToken, revokeToken } from "./agents-api";
import { listExecutorContracts } from "./executor-orders-api";
import { saveHoldings } from "./owner-api";

const silent = { info: () => undefined, warn: () => undefined };
const ORIGIN = "http://console.test";
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
      testConsoleConfig(dataDir, { mandates: { ...readMandatesConfig({}), maxPerWorkspace: 3 } }),
      openDatabase(dataDir),
      { env: chain.env, logger: silent },
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
    const before = snapshotOf(right.id).chain?.committedCents ?? 0;
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
});
