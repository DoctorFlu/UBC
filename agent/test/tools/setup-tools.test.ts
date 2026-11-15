import { describe, expect, it } from "vitest";
import { Category, categoryMask } from "@mandate/shared";
import { getSetupState } from "../../src/tools/get-setup-state";
import { requestPairing } from "../../src/tools/request-pairing";
import { requestPolicyChange } from "../../src/tools/request-policy-change";
import { harness } from "../fakes";
import { TEST_ADDRESS } from "../helpers";

type Step = { key: string; done: boolean; actor: string; hint: string };
const steps = (structured: Record<string, unknown>) => structured["steps"] as Step[];
const pending = (structured: Record<string, unknown>) =>
  steps(structured)
    .filter((s) => !s.done)
    .map((s) => s.key);

describe("get_setup_state with live checks", () => {
  it("walks a fresh connection through pairing to ready", async () => {
    const h = harness();
    const first = await getSetupState.run({}, h.ctx);
    expect(first.structured["ready"]).toBe(false);
    expect(pending(first.structured)).toEqual(["pairing_requested", "pairing_confirmed"]);
    // The agent's own step comes first, with a hint it can act on.
    expect(first.structured["nextAction"]).toEqual({
      actor: "agent",
      hint: "Call request_pairing, then give the owner the claim link it returns.",
    });

    const paired = await requestPairing.run({}, h.ctx);
    const claimUrl = (paired.structured["pairing"] as { claimUrl: string }).claimUrl;
    expect(paired.structured).toMatchObject({ status: "held", nextAction: { actor: "owner" } });
    expect(paired.summary).toContain(claimUrl);

    const waiting = await getSetupState.run({}, h.ctx);
    expect(pending(waiting.structured)).toEqual(["pairing_confirmed"]);
    expect(waiting.structured["nextAction"]).toMatchObject({
      actor: "owner",
      hint: expect.stringContaining(claimUrl) as unknown,
    });

    h.console.confirmPairing();
    const ready = await getSetupState.run({}, h.ctx);
    expect(ready.structured).toMatchObject({ status: "ok", ready: true });
    expect(ready.summary).toMatch(/^Setup is complete \(\d+ of \d+ steps done\)\.$/);
  });

  it("names what the owner must fix on the chain side", async () => {
    const h = harness();
    h.policy.contractAgent = "0x0000000000000000000000000000000000000001";
    h.policy.gasWei = 0n;
    h.policy.rules = { ...h.policy.rules, paused: true, allowedCategories: 0 };
    const { structured } = await getSetupState.run({}, h.ctx);
    const left = steps(structured).filter((s) => !s.done);
    expect(left.map((s) => s.key)).toEqual(
      expect.arrayContaining(["agent_role", "agent_gas", "mandate_rules", "not_paused"]),
    );
    expect(left.find((s) => s.key === "agent_role")?.hint).toContain(TEST_ADDRESS);
    expect(left.every((s) => s.actor === "owner" || s.key.startsWith("pairing"))).toBe(true);
  });

  it("reports an unreachable chain and console as steps instead of failing", async () => {
    const h = harness();
    h.console.setDown(true);
    const { HttpRequestError } = await import("viem");
    h.policy.snapshot = () => Promise.reject(new HttpRequestError({ url: "http://rpc" }));
    const { structured } = await getSetupState.run({}, h.ctx);
    expect(pending(structured)).toEqual(
      expect.arrayContaining(["chain_reachable", "console_reachable", "holdings"]),
    );
  });

  it("lists only configuration steps on a bare server", async () => {
    const h = harness({
      policy: null,
      console: false,
      env: { AGENT_PRIVATE_KEY: "", POLICY_ADDRESS: "", CONSOLE_SERVICE_TOKEN: "" },
    });
    const { structured } = await getSetupState.run({}, h.ctx);
    expect(steps(structured).map((s) => s.key)).toEqual(["agent_key", "policy_contract", "console_link"]);
  });
});

describe("request_pairing", () => {
  it("is idempotent and reports a confirmed agent", async () => {
    const h = harness();
    await requestPairing.run({ agentName: "Grok Bot" }, h.ctx);
    h.console.confirmPairing();
    const again = await requestPairing.run({ agentName: "Grok Bot" }, h.ctx);
    expect(again.structured).toMatchObject({
      status: "ok",
      pairing: { status: "confirmed", agentAddress: TEST_ADDRESS, isContractAgent: true },
    });
  });

  it("answers unavailable without a console", async () => {
    expect((await requestPairing.run({}, harness({ console: false }).ctx)).structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "CONSOLE_NOT_CONFIGURED" }],
    });
  });
});

describe("request_policy_change (issue #34)", () => {
  it("files only the changed rules with the reason, as a diff the owner decides on", async () => {
    const h = harness();
    const { structured, summary } = await requestPolicyChange.run(
      {
        maxTradeCents: 5_000,
        budgetCents: 20_000,
        allowedCategories: ["Crypto", "Economics"],
        reason: "Owner wants bigger rungs.",
      },
      h.ctx,
    );
    expect(structured).toMatchObject({
      status: "held",
      nextAction: { actor: "owner" },
      request: {
        status: "pending",
        changes: [
          { rule: "max trade size", from: "$25.00", to: "$50.00" },
          { rule: "allowed categories", from: "Crypto", to: "Crypto, Economics" },
        ],
      },
    });
    const filed = [...h.console.state.changeRequests.values()][0];
    expect(filed).toMatchObject({
      agentAddress: TEST_ADDRESS,
      proposed: {
        maxTradeCents: 5_000,
        allowedCategories: categoryMask([Category.Crypto, Category.Economics]),
      },
      reason: "Owner wants bigger rungs.",
    });
    expect(filed?.proposed).not.toHaveProperty("budgetCents");
    expect(summary).toContain("The current rules still apply");
    // Nothing onchain changed.
    expect(h.policy.rules.maxTradeCents).toBe(2_500);
  });

  it("can never ask to pause or unpause", async () => {
    await expect(
      requestPolicyChange.run({ paused: false, reason: "Resume." }, harness().ctx),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("paused") as unknown,
    });
  });

  it("requires a reason, and rejects a request that changes nothing", async () => {
    await expect(requestPolicyChange.run({ maxTradeCents: 1 }, harness().ctx)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const same = await requestPolicyChange.run({ maxTradeCents: 2_500, reason: "Same." }, harness().ctx);
    expect(same.structured).toMatchObject({ status: "rejected", reasons: [{ code: "NO_CHANGE" }] });
  });

  it("answers unavailable when the console is down", async () => {
    const h = harness();
    h.console.setDown(true);
    expect(
      (await requestPolicyChange.run({ maxTradeCents: 5_000, reason: "x" }, h.ctx)).structured,
    ).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "CONSOLE_UNREACHABLE" }],
    });
  });
});
