import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { claimFirstWorkspace, mandateOf, signUpWorkspace } from "../../../test/support/accounts";
import { SoftPasskey } from "../../../test/support/passkey";
import { testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { type Database, openDatabase } from "../db";
import type { Access } from "./accounts";
import { AccountError } from "./accounts";
import { STEP_UP_TTL_MS, StepUp, type StepUpAction, type StepUpTarget } from "./step-up";
import { AccountStore, type Member } from "./store";

/**
 * The passkey step-up (#95): one challenge, bound to one exact owner action of one member, answered once
 * with that member's own passkey and user verification, within its short expiry. Everything else refused.
 */
describe("passkey step-up for owner actions", () => {
  let service: ConsoleService;
  let db: Database;
  let clock: number;
  let stepUp: StepUp;
  let alice: Member;
  let aliceKey: SoftPasskey;
  let aliceAccess: Access;

  const origin = "http://console.test";
  const contract = { chainId: 5042002, address: "0x00000000000000000000000000000000000000aa" };
  const RULES = {
    budgetCents: 10_000,
    maxTradeCents: 2_500,
    allowedCategories: 3,
    approvalAboveCents: 2_000,
    dailyLossCents: 0,
    paused: false,
  };

  function accessOf(member: Member): Access {
    const access = service.accounts.access(service.accounts.openSession(member));
    if (!access) throw new Error("no access");
    return access;
  }

  /** A second member of a workspace, as an invite would add one (the store has no such path yet). */
  function addMember(workspaceId: string, name: string, role: "admin" | "viewer", key: SoftPasskey): Member {
    const id = `mbr_${name.toLowerCase()}`;
    db.prepare(
      "INSERT INTO members (id, workspace_id, name, role, webauthn_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, workspaceId, name, role, `${name}-handle`, new Date(clock).toISOString());
    service.accounts.store.addPasskey(id, key.stored());
    const member = service.accounts.store.member(id);
    if (!member) throw new Error("no member");
    return member;
  }

  function approve(mandateId: string, intentId = 1): StepUpAction {
    return { kind: "owner-call", mandateId, call: { functionName: "approveIntent", intentId } };
  }

  function targetOf(access: Access): StepUpTarget {
    return { workspaceId: access.workspace.id, contract };
  }

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (AccountError.is(error)) return error.code;
      throw error;
    }
    throw new Error("the step-up was not refused");
  }

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-step-up-"));
    db = openDatabase(dataDir);
    service = new ConsoleService(testConsoleConfig(dataDir), db);
    clock = Date.parse("2026-11-17T12:00:00Z");
    stepUp = new StepUp(service.config.accounts, new AccountStore(db, () => new Date(clock)));
    alice = claimFirstWorkspace(service, "Alice");
    aliceKey = new SoftPasskey(origin);
    service.accounts.store.addPasskey(alice.id, aliceKey.stored());
    aliceAccess = accessOf(alice);
  });

  it("authorises the exact action once, with the member's passkey and user verification", async () => {
    const action = approve(mandateOf(service, alice));
    const target = targetOf(aliceAccess);
    const started = await stepUp.begin(aliceAccess, action, target);
    expect(started.options.userVerification).toBe("required");
    expect(started.options.allowCredentials?.map((c) => c.id)).toContain(aliceKey.id);
    const answer = { id: started.id, response: aliceKey.get(started.options) };
    const confirmed = await stepUp.finish(aliceAccess, answer, { action, target });
    expect(confirmed.action).toEqual(action);
    expect(confirmed.credentialId).toBe(aliceKey.id);
    expect(service.accounts.store.passkey(aliceKey.id)?.counter).toBeGreaterThan(0);

    // A replayed answer: the challenge was used up.
    expect(await refusal(stepUp.finish(aliceAccess, answer, { action, target }))).toBe("step_up_expired");
  });

  it("refuses an answer for another action, intent or mandate than the challenge's", async () => {
    const mandateId = mandateOf(service, alice);
    const target = targetOf(aliceAccess);
    const others: { action: StepUpAction; target: StepUpTarget }[] = [
      { action: approve(mandateId, 2), target },
      {
        action: { kind: "owner-call", mandateId, call: { functionName: "rejectIntent", intentId: 1 } },
        target,
      },
      { action: approve("mnd_other"), target },
      { action: approve(mandateId), target: { ...target, contract: { ...contract, chainId: 1 } } },
      {
        action: approve(mandateId),
        target: {
          ...target,
          contract: { ...contract, address: "0x00000000000000000000000000000000000000bb" },
        },
      },
      {
        action: { kind: "owner-call", mandateId, call: { functionName: "setPolicy", rules: RULES } },
        target,
      },
    ];
    for (const other of others) {
      const started = await stepUp.begin(aliceAccess, approve(mandateId), target);
      const answer = { id: started.id, response: aliceKey.get(started.options) };
      expect(await refusal(stepUp.finish(aliceAccess, answer, other)), JSON.stringify(other)).toBe(
        "step_up_refused",
      );
      // Refused is used up: the right action cannot reuse it afterwards.
      expect(await refusal(stepUp.finish(aliceAccess, answer, { action: approve(mandateId), target }))).toBe(
        "step_up_expired",
      );
    }
  });

  it("refuses an expired challenge", async () => {
    const action = approve(mandateOf(service, alice));
    const target = targetOf(aliceAccess);
    const started = await stepUp.begin(aliceAccess, action, target);
    clock += STEP_UP_TTL_MS + 1;
    const answer = { id: started.id, response: aliceKey.get(started.options) };
    expect(await refusal(stepUp.finish(aliceAccess, answer, { action, target }))).toBe("step_up_expired");
  });

  it("refuses a member of another workspace, even answering with their own passkey", async () => {
    const action = approve(mandateOf(service, alice));
    const target = targetOf(aliceAccess);
    const started = await stepUp.begin(aliceAccess, action, target);
    const mallory = signUpWorkspace(service, "Mallory");
    const malloryKey = new SoftPasskey(origin);
    service.accounts.store.addPasskey(mallory.id, malloryKey.stored());
    const answer = { id: started.id, response: malloryKey.get(started.options) };
    expect(await refusal(stepUp.finish(accessOf(mallory), answer, { action, target }))).toBe(
      "step_up_refused",
    );
  });

  it("refuses a stolen session: the session alone, or with a passkey that is not the member's", async () => {
    const action = approve(mandateOf(service, alice));
    const target = targetOf(aliceAccess);
    // The thief holds Alice's session and asks for a challenge; they have no passkey of hers.
    const started = await stepUp.begin(aliceAccess, action, target);
    const thiefKey = new SoftPasskey(origin);
    const forged = { id: started.id, response: { ...thiefKey.get(started.options), id: aliceKey.id } };
    expect(await refusal(stepUp.finish(aliceAccess, forged, { action, target }))).toBe("step_up_refused");
    const again = await stepUp.begin(aliceAccess, action, target);
    const own = { id: again.id, response: thiefKey.get(again.options) };
    expect(await refusal(stepUp.finish(aliceAccess, own, { action, target }))).toBe("step_up_refused");
  });

  it("refuses a passkey of another member of the same workspace: the challenge is the asker's", async () => {
    const action = approve(mandateOf(service, alice));
    const target = targetOf(aliceAccess);
    const bobKey = new SoftPasskey(origin);
    const bob = addMember(alice.workspaceId, "Bob", "admin", bobKey);
    const started = await stepUp.begin(aliceAccess, action, target);
    const answer = { id: started.id, response: bobKey.get(started.options) };
    expect(await refusal(stepUp.finish(aliceAccess, answer, { action, target }))).toBe("step_up_refused");
    expect(bob.workspaceId).toBe(alice.workspaceId);
  });

  it("refuses an answer without user verification, or from another origin", async () => {
    const action = approve(mandateOf(service, alice));
    const target = targetOf(aliceAccess);
    const presence = await stepUp.begin(aliceAccess, action, target);
    const unverified = { id: presence.id, response: aliceKey.get(presence.options, { userVerified: false }) };
    expect(await refusal(stepUp.finish(aliceAccess, unverified, { action, target }))).toBe("step_up_refused");
    const phished = await stepUp.begin(aliceAccess, action, target);
    const elsewhere = {
      id: phished.id,
      response: aliceKey.get(phished.options, { origin: "https://evil.example" }),
    };
    expect(await refusal(stepUp.finish(aliceAccess, elsewhere, { action, target }))).toBe("step_up_refused");
  });

  it("asks only admins with a passkey", async () => {
    const action = approve(mandateOf(service, alice));
    const target = targetOf(aliceAccess);
    const viewer = addMember(alice.workspaceId, "Viewer", "viewer", new SoftPasskey(origin));
    expect(await refusal(stepUp.begin(accessOf(viewer), action, target))).toBe("forbidden");
  });
});
