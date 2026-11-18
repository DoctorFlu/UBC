import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devAccount } from "@mandate/devchain";
import {
  CONSOLE_EXECUTOR_ROUTES,
  Category,
  type Settlement,
  consoleErrorSchema,
  hashSettlement,
  settlementMessage,
} from "@mandate/shared";
import type { LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newNonce, ownerRequestMessage } from "@/lib/owner-request";

import type { Member } from "../accounts/store";
import { claimFirstWorkspace, consoleHeaders, envMandate, envSnapshot } from "../../../test/support/accounts";
import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../../test/support/devchain";
import { testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { putSettlement } from "./executor-api";
import { saveHoldings } from "./owner-api";

const silent = { info: () => undefined, warn: () => undefined };

/**
 * Policy v2's owner can hand each role to another account (`setUser`, `setExecutor`). Every check that
 * trusts a role reads it from the contract for that request, so the account that held it is refused at
 * once and its successor accepted, while the console's own reading of the contract has not yet seen the
 * change. The console here polls once a minute, so for these tests its cached roles are the old ones.
 */
describe("checks that trust a role read it from the contract", () => {
  let chain: TestChain;
  let service: ConsoleService;
  let owner: Member;
  let filledId: number;

  const cachedRoles = () => envSnapshot(service).contract?.roles;

  function settlementOf(intentId: number): Settlement {
    return {
      version: 1,
      chainId: chain.executor.publicClient.chain.id,
      policy: chain.address.toLowerCase() as `0x${string}`,
      intentId,
      market: BTC_ABOVE_65K,
      eventTicker: "BTC2611202200",
      strikeCents: 6_500_000,
      expiresAt: "2026-11-20T22:00:00.000Z",
      outcome: "NO",
      costCents: 1_240,
      limitPrice: 31,
      contractsHundredths: 4_000,
      resolution: "no",
      payoutCents: 4_000,
      pnlCents: 2_760,
      settlementValue: "64992.864",
      resolvedAt: "2026-11-20T22:00:08.232Z",
      venue: "simulated",
    };
  }

  async function putSigned(document: Settlement, signer: LocalAccount): Promise<Response> {
    const signature = await signer.signMessage({ message: settlementMessage(hashSettlement(document)) });
    const request = new Request(
      `http://console.test${CONSOLE_EXECUTOR_ROUTES.settlement(document.intentId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document, signature }),
      },
    );
    return putSettlement(request, service, { intentId: String(document.intentId) });
  }

  async function saveHoldingsSignedBy(signer: LocalAccount): Promise<Response> {
    const payload = { holdings: [{ asset: "BTC", quantity: "0.05" }] };
    const issuedAt = new Date().toISOString();
    const nonce = newNonce();
    const message = ownerRequestMessage({
      action: "holdings.save",
      payload,
      policyAddress: chain.address,
      chainId: envSnapshot(service).network.chainId,
      issuedAt,
      nonce,
    });
    const signature = await signer.signMessage({ message });
    return saveHoldings(
      new Request(`http://console.test/api/console?mandate=${envMandate(service).id}`, {
        method: "POST",
        headers: consoleHeaders(service, owner),
        body: JSON.stringify({ payload, auth: { issuedAt, nonce, signature } }),
      }),
      service,
    );
  }

  async function errorCode(response: Response): Promise<string> {
    return consoleErrorSchema.parse(await response.json()).error.code;
  }

  beforeAll(async () => {
    chain = await startTestChain();
    const proposed = await chain.agent.proposeTrade({
      market: BTC_ABOVE_65K,
      category: Category.Crypto,
      outcome: "NO",
      isBuy: true,
      amountCents: 1_240,
      limitPrice: 31,
    });
    filledId = proposed.intentId;
    await chain.executor.recordResult({ intentId: filledId, filled: true, filledCents: 1_240, pnlCents: 0 });
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-roles-"));
    service = new ConsoleService(
      testConsoleConfig(dataDir, { pollIntervalMs: 60_000 }),
      openDatabase(dataDir),
      {
        env: chain.env,
        logger: silent,
      },
    );
    owner = claimFirstWorkspace(service);
    service.start();
    if (!(await service.whenSynced(15_000))) throw new Error("the console did not sync");
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("refuses the executor's record once the executor is handed over, and takes its successor's", async () => {
    const previous = devAccount("executor");
    const next = privateKeyToAccount(generatePrivateKey());
    await chain.user.setExecutor(next.address);
    expect(cachedRoles()?.executor).toBe(previous.address);

    const old = await putSigned(settlementOf(filledId), previous);
    expect(old.status).toBe(403);
    expect(await errorCode(old)).toBe("not_executor");
    const successor = await putSigned(settlementOf(filledId), next);
    expect(successor.status).toBe(201);
  });

  it("refuses the owner's signature once the contract is handed to another account, and takes the new owner's", async () => {
    const previous = devAccount("user");
    const next = privateKeyToAccount(generatePrivateKey());
    await chain.user.setUser(next.address);
    expect(cachedRoles()?.user).toBe(previous.address);

    const old = await saveHoldingsSignedBy(previous);
    expect(old.status).toBe(403);
    expect(await errorCode(old)).toBe("not_owner");
    const successor = await saveHoldingsSignedBy(next);
    expect(successor.status, await successor.clone().text()).toBe(200);
  });
});

/**
 * The views follow the role events: a handed-over role shows at the next sync, not when the cached roles
 * next expire (every 10 s).
 */
describe("the console's views follow the role events", () => {
  let chain: TestChain;
  let service: ConsoleService;

  beforeAll(async () => {
    chain = await startTestChain();
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-roles-"));
    service = new ConsoleService(testConsoleConfig(dataDir, { pollIntervalMs: 50 }), openDatabase(dataDir), {
      env: chain.env,
      logger: silent,
    });
    claimFirstWorkspace(service);
    service.start();
    if (!(await service.whenSynced(15_000))) throw new Error("the console did not sync");
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("shows a new agent within a sync of AgentChanged", async () => {
    await service.serverRoles();
    const next = privateKeyToAccount(generatePrivateKey()).address;
    const startedAt = Date.now();
    await chain.user.setAgent(next);
    while (envSnapshot(service).contract?.roles?.agent !== next) {
      if (Date.now() - startedAt > 5_000) throw new Error("the new agent did not show");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(envSnapshot(service).chain?.events.at(-1)).toMatchObject({ type: "AgentChanged", current: next });
  });
});
