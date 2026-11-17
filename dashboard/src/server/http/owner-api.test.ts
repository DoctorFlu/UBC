import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEMO_POLICY } from "@mandate/devchain";
import { type PolicyClient, consoleErrorSchema } from "@mandate/shared";
import type { EnvVars } from "@mandate/shared/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type OwnerAction, newNonce, ownerRequestMessage } from "@/lib/owner-request";

import type { Member } from "../accounts/store";
import {
  claimFirstWorkspace,
  consoleHeaders,
  envMandate,
  envSnapshot,
  mandateOf,
  signUpWorkspace,
} from "../../../test/support/accounts";
import { type TestChain, startTestChain } from "../../../test/support/devchain";
import { testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { confirmPairing, dismissChangeRequest, markChangeRequestApplied, saveHoldings } from "./owner-api";

const silent = { info: () => undefined, warn: () => undefined };

function makeService(env: EnvVars): ConsoleService {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
  return new ConsoleService(testConsoleConfig(dataDir), openDatabase(dataDir), { env, logger: silent });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(consoleErrorSchema.parse(await response.json()).error.code).toBe(code);
}

describe("owner-signed console routes", () => {
  let chain: TestChain;
  let service: ConsoleService;
  /** The member who claimed the workspace that holds the server's own mandate. */
  let owner: Member;

  /** Headers of a request from the console's pages, signed in as `member`. */
  const headers = (member: Member = owner) => consoleHeaders(service, member);
  const mandateId = () => envMandate(service).id;
  /** Where the console's pages send a write: naming the mandate it is for. */
  const consoleUrl = () => `http://console.test/api/console?mandate=${mandateId()}`;

  /** A request body signed the way the console's browser code signs it. */
  async function signed(
    signer: PolicyClient,
    action: OwnerAction,
    payload: unknown,
    options: { issuedAt?: string; nonce?: string } = {},
  ): Promise<Request> {
    const wallet = signer.walletClient;
    if (!wallet) throw new Error("signer has no wallet");
    const issuedAt = options.issuedAt ?? new Date().toISOString();
    const nonce = options.nonce ?? newNonce();
    const message = ownerRequestMessage({
      action,
      payload,
      policyAddress: chain.address,
      chainId: envSnapshot(service).network.chainId,
      issuedAt,
      nonce,
    });
    const signature = await wallet.signMessage({ account: wallet.account, message });
    return new Request(consoleUrl(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ payload, auth: { issuedAt, nonce, signature } }),
    });
  }

  function agentAddress() {
    const address = chain.agent.account?.address;
    if (!address) throw new Error("no agent account");
    return address;
  }

  beforeAll(async () => {
    chain = await startTestChain();
    service = makeService(chain.env);
    owner = claimFirstWorkspace(service);
    service.start();
    if (!(await service.whenSynced(15_000))) throw new Error("the console did not sync");
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  const holdings = { holdings: [{ asset: "BTC", quantity: "0.05" }] };

  it("answers 401 without a session and 403 for a write from another site, before reading the body", async () => {
    const request = await signed(chain.user, "holdings.save", holdings);
    const body = await request.text();
    const anonymous = new Request(consoleUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", origin: service.config.accounts.origin },
      body,
    });
    await expectError(await saveHoldings(anonymous, service), 401, "unauthenticated");
    const crossSite = new Request(consoleUrl(), {
      method: "POST",
      headers: { ...headers(), origin: "https://evil.example" },
      body,
    });
    await expectError(await saveHoldings(crossSite, service), 403, "cross_origin");
    const noOrigin = new Request(consoleUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: headers().cookie ?? "" },
      body,
    });
    await expectError(await saveHoldings(noOrigin, service), 403, "cross_origin");
    expect(service.offchain.holdings(mandateId()).holdings).toEqual([]);
  });

  it("acts on the session's own mandate only: another workspace's owner signature reaches nothing", async () => {
    const stranger = signUpWorkspace(service, "Stranger");
    // Even the contract owner's own signature does nothing in a workspace without that contract.
    const request = await signed(chain.user, "holdings.save", holdings);
    const response = await saveHoldings(
      new Request(`http://console.test/api/console?mandate=${mandateOf(service, stranger)}`, {
        method: "POST",
        headers: headers(stranger),
        body: await request.text(),
      }),
      service,
    );
    await expectError(response, 409, "no_contract");
    expect(service.offchain.holdings(mandateId()).holdings).toEqual([]);
    // Naming the other workspace's mandate is a 404, the same as a mandate that does not exist.
    const named = await saveHoldings(
      new Request(`http://console.test/api/console?mandate=${mandateId()}`, {
        method: "POST",
        headers: headers(stranger),
        body: JSON.stringify({}),
      }),
      service,
    );
    await expectError(named, 404, "not_found");
  });

  it("saves holdings signed by the owner and refuses the same signature twice", async () => {
    const nonce = newNonce();
    const issuedAt = new Date().toISOString();
    const response = await saveHoldings(
      await signed(chain.user, "holdings.save", holdings, { nonce, issuedAt }),
      service,
    );
    expect(response.status).toBe(200);
    expect(service.offchain.holdings(mandateId()).holdings).toEqual(holdings.holdings);

    const replay = await saveHoldings(
      await signed(chain.user, "holdings.save", holdings, { nonce, issuedAt }),
      service,
    );
    await expectError(replay, 401, "replayed_signature");
  });

  it("refuses a wallet that is not the owner, and keeps its nonce usable", async () => {
    const nonce = newNonce();
    await expectError(
      await saveHoldings(await signed(chain.agent, "holdings.save", holdings, { nonce }), service),
      403,
      "not_owner",
    );
    const retried = await saveHoldings(
      await signed(chain.user, "holdings.save", holdings, { nonce }),
      service,
    );
    expect(retried.status).toBe(200);
  });

  it("refuses a stale signature and one signed for another action or payload", async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await expectError(
      await saveHoldings(await signed(chain.user, "holdings.save", holdings, { issuedAt: old }), service),
      401,
      "stale_signature",
    );

    const otherAction = await signed(chain.user, "pairing.confirm", holdings);
    await expectError(await saveHoldings(otherAction, service), 403, "not_owner");

    const request = await signed(chain.user, "holdings.save", holdings);
    const body = (await request.json()) as { payload: unknown; auth: unknown };
    const swapped = new Request(consoleUrl(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...body, payload: { holdings: [{ asset: "BTC", quantity: "50" }] } }),
    });
    await expectError(await saveHoldings(swapped, service), 403, "not_owner");
  });

  it("refuses invalid holdings before checking the signature", async () => {
    const duplicate = { holdings: [holdings.holdings[0], holdings.holdings[0]] };
    await expectError(
      await saveHoldings(await signed(chain.user, "holdings.save", duplicate), service),
      422,
      "invalid_body",
    );
    const unsigned = new Request(consoleUrl(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ payload: holdings }),
    });
    await expectError(await saveHoldings(unsigned, service), 422, "invalid_body");
  });

  it("confirms an announced agent, and answers 404 for one that never announced", async () => {
    const agent = chain.agent.account?.address;
    if (!agent) throw new Error("no agent account");
    const stranger = chain.outsider.account?.address ?? agent;
    await expectError(
      await confirmPairing(await signed(chain.user, "pairing.confirm", { agentAddress: stranger }), service),
      404,
      "not_found",
    );
    service.offchain.announce(mandateId(), {
      agentAddress: agent,
      agentName: "Grok Bot",
      serverVersion: "0.1.0",
    });
    const response = await confirmPairing(
      await signed(chain.user, "pairing.confirm", { agentAddress: agent }),
      service,
    );
    expect(response.status).toBe(200);
    expect(service.offchain.pairing(mandateId(), agent)?.status).toBe("confirmed");
  });

  it("dismisses a change request only when the signed id matches the path", async () => {
    const filed = service.offchain.createChangeRequest(mandateId(), {
      agentAddress: agentAddress(),
      proposed: { maxTradeCents: 3_000 },
      reason: "A bigger rung.",
    });
    await expectError(
      await dismissChangeRequest(
        await signed(chain.user, "change-request.dismiss", { id: "pcr_other" }),
        service,
        { id: filed.id },
      ),
      422,
      "invalid_body",
    );
    const response = await dismissChangeRequest(
      await signed(chain.user, "change-request.dismiss", { id: filed.id }),
      service,
      { id: filed.id },
    );
    expect(response.status).toBe(200);
    expect(service.offchain.changeRequest(mandateId(), filed.id)?.status).toBe("dismissed");
  });

  it("cannot dismiss another workspace's change request, even with a valid owner signature", async () => {
    const stranger = signUpWorkspace(service, "Other workspace");
    const [theirs] = service.accounts.store.agentsOf(stranger.workspaceId);
    if (!theirs) throw new Error("no mandate");
    const filed = service.offchain.createChangeRequest(theirs.mandate.id, {
      agentAddress: agentAddress(),
      proposed: { maxTradeCents: 3_000 },
      reason: "Someone else's request.",
    });
    // The first workspace's owner signs for the id; the session's mandate has no such request.
    await expectError(
      await dismissChangeRequest(
        await signed(chain.user, "change-request.dismiss", { id: filed.id }),
        service,
        { id: filed.id },
      ),
      404,
      "not_found",
    );
    expect(service.offchain.changeRequest(theirs.mandate.id, filed.id)?.status).toBe("pending");
  });

  it("marks a change request applied only for the owner's matching setPolicy transaction", async () => {
    const filed = service.offchain.createChangeRequest(mandateId(), {
      agentAddress: agentAddress(),
      proposed: { maxTradeCents: 3_000 },
      reason: "A bigger rung.",
    });
    const applied = (txHash: string) =>
      markChangeRequestApplied(
        new Request(consoleUrl(), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ txHash }),
        }),
        service,
        { id: filed.id },
      );

    const pause = await chain.user.setPaused(true);
    await expectError(await applied(pause.txHash), 422, "not_applied");
    const other = await chain.user.setPolicy({ ...DEMO_POLICY, maxTradeCents: 2_900 });
    const otherError = await applied(other.txHash);
    expect(otherError.status).toBe(422);
    expect(consoleErrorSchema.parse(await otherError.json()).error.message).toContain("maxTradeCents");
    await expectError(await applied(`0x${"ab".repeat(32)}`), 422, "unknown_transaction");

    const matching = await chain.user.setPolicy({ ...DEMO_POLICY, maxTradeCents: 3_000 });
    const response = await applied(matching.txHash);
    expect(response.status).toBe(200);
    expect(service.offchain.changeRequest(mandateId(), filed.id)).toMatchObject({
      status: "applied",
      appliedTxHash: matching.txHash,
    });
    await expectError(
      await markChangeRequestApplied(
        new Request(consoleUrl(), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ txHash: matching.txHash }),
        }),
        service,
        { id: "pcr_missing" },
      ),
      404,
      "not_found",
    );
  });
});
