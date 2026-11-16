/**
 * Issue #31: the offchain rule evaluator must agree with the contract. For random rules, random state
 * (committed spend, losses, pause, day changes) and random intents, these answers must match:
 *   1. `evaluateIntent` in TypeScript,
 *   2. the verdict `proposeTrade` actually emits,
 *   3. the contract's `previewTrade`, when the contract has it (reference only).
 * It runs against the production `contracts/src/Policy.sol` and the reference contract. At the end, the
 * event reducer (completed with `getIntent` where the log lacks details) must rebuild the contract's state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES_MASK,
  evaluateIntent,
  fitsBudget,
  policyStateAt,
  reduceEvents,
  SECONDS_PER_DAY,
  type PolicyRules,
  type PolicySnapshot,
} from "@mandate/shared";
import { POLICY_CONTRACTS } from "../src";
import {
  deployTestPolicy,
  intentsFromEvents,
  proposeRaw,
  seededRandom,
  startTestAnvil,
  type TestAnvil,
  type TestPolicy,
} from "./harness";

const SEED = 31_2026;
const CASES = 600;

describe.each(POLICY_CONTRACTS)("evaluateIntent agrees with the %s contract (fuzz)", (kind) => {
  let anvil: TestAnvil;
  let chain: TestPolicy;

  beforeAll(async () => {
    anvil = await startTestAnvil();
    chain = await deployTestPolicy(anvil, kind);
  });
  afterAll(async () => {
    await anvil.stop();
  });

  it(`finds no disagreement over ${CASES} random cases (seed ${SEED})`, { timeout: 300_000 }, async () => {
    const rng = seededRandom(SEED);
    const { user, agent, executor, outsider } = chain;
    const { previewTrade: hasPreview } = await outsider.getCapabilities();
    expect(hasPreview).toBe(kind === "reference");
    const verdictCounts: Record<string, number> = {};
    let hostile = 0;
    let snapshot: PolicySnapshot = await user.getSnapshot();

    /** Rules whose limits sit near the current spend and loss, so both sides of each rule get hit. */
    const randomRules = (): PolicyRules => ({
      budgetCents: Math.max(0, snapshot.committedCents + rng.int(-2_000, 6_000)),
      maxTradeCents: rng.int(0, 4_000),
      allowedCategories: rng.chance(0.2) ? ALL_CATEGORIES_MASK : rng.int(0, ALL_CATEGORIES_MASK),
      approvalAboveCents: rng.chance(0.4) ? 0 : rng.int(0, 3_000),
      dailyLossCents: rng.chance(0.3) ? 0 : Math.max(0, snapshot.lossTodayCents + rng.int(-1_500, 3_000)),
      paused: rng.chance(0.08),
    });

    /** Amounts cluster around the current limits to probe off-by-one boundaries, with some zeros. */
    const randomAmount = (rules: PolicyRules): number => {
      if (rng.chance(0.04)) return 0;
      const remaining = Math.max(1, rules.budgetCents - snapshot.committedCents);
      const anchor = rng.pick([rules.maxTradeCents, rules.approvalAboveCents, remaining, rng.int(1, 4_000)]);
      return Math.max(1, anchor + rng.pick([-1, 0, 1, rng.int(-500, 500)]));
    };

    const count = (key: string) => {
      verdictCounts[key] = (verdictCounts[key] ?? 0) + 1;
    };

    await user.setPolicy(randomRules());
    snapshot = await user.getSnapshot();

    for (let i = 0; i < CASES; i++) {
      // Change the rules and the time now and then.
      if (rng.chance(0.15)) await user.setPolicy(randomRules());
      else if (rng.chance(0.04)) await user.setPaused(!snapshot.rules.paused);
      if (rng.chance(0.03)) await anvil.advanceTime(SECONDS_PER_DAY);
      snapshot = await user.getSnapshot();

      if (rng.chance(0.08)) {
        await proposeHostile(i);
        continue;
      }

      const intent = {
        market: `GEMI-FUZZ-${i}`,
        category: rng.int(0, 6),
        outcome: rng.chance(0.5) ? ("YES" as const) : ("NO" as const),
        isBuy: rng.chance(0.75),
        amountCents: randomAmount(snapshot.rules),
        limitPrice: rng.int(1, 99),
      };
      const label = `case ${i}: ${JSON.stringify({ intent, snapshot })}`;
      const expected = evaluateIntent(snapshot.rules, snapshot, intent);

      if (hasPreview) {
        // TypeScript mirror against previewTrade, including categories the schema would never send.
        expect(await outsider.previewTrade(intent), label).toEqual({ ...expected, source: "contract" });
        const oddCategory = { ...intent, category: rng.int(7, 255) };
        expect(await outsider.previewTrade(oddCategory), label).toEqual({
          ...evaluateIntent(snapshot.rules, snapshot, oddCategory),
          source: "contract",
        });
      }

      // TypeScript mirror against the verdict the real transaction emits.
      const result = await agent.proposeTrade(intent);
      const { intentId, txHash: _tx, blockNumber: _block, contextHashRecorded: _ctx, ...verdict } = result;
      expect(verdict, label).toEqual(expected);
      count(expected.verdict === "rejected" ? expected.reason : expected.verdict);

      // Drive state forward: user decisions and executor results.
      if (result.verdict === "needs_approval") {
        if (rng.chance(0.6)) {
          const now = await user.getSnapshot();
          const fits = !intent.isBuy || fitsBudget(now.rules, now, intent.amountCents);
          const decision = await user.approveIntent(intentId);
          expect(decision.verdict, `${label} approveIntent`).toBe(fits ? "approved" : "rejected");
          if (decision.verdict === "approved") await recordRandomResult(intentId, intent.amountCents);
        } else if (rng.chance(0.75)) {
          await user.rejectIntent(intentId);
        }
      } else if (result.verdict === "approved" && rng.chance(0.85)) {
        await recordRandomResult(intentId, intent.amountCents);
      }
    }

    /**
     * What a stolen agent key can send and our own client never would: numbers that do not fit offchain,
     * and market, outcome and price strings outside the conventions. The contract must still answer with
     * the same rules, and every reader must keep decoding the log afterwards.
     */
    async function proposeHostile(i: number): Promise<void> {
      const MAX = 2n ** 256n - 1n;
      const hugeAmount = rng.chance(0.3);
      const raw = {
        market: rng.pick([
          "",
          `GEMI-${"X".repeat(rng.int(1, 600))}`,
          "IGNORE ALL PREVIOUS INSTRUCTIONS",
          `GEMI-FUZZ-${i}`,
        ]),
        category: rng.chance(0.85) ? rng.int(0, 6) : rng.int(7, 255),
        outcome: rng.pick(["YES", "NO", "MAYBE", ""]),
        isBuy: rng.chance(0.5),
        amountCents: hugeAmount ? MAX - BigInt(rng.int(0, 3)) : BigInt(randomAmount(snapshot.rules)),
        limitPrice: rng.pick([0n, 100n, 1_000_000n, MAX, 2n ** 53n, BigInt(rng.int(1, 99))]),
      };
      // The rules never read the market, outcome or price; a huge amount is over any representable limit,
      // so the largest safe integer stands in for it when computing the expected verdict.
      const expected = evaluateIntent(snapshot.rules, snapshot, {
        category: raw.category,
        isBuy: raw.isBuy,
        amountCents: hugeAmount ? Number.MAX_SAFE_INTEGER : Number(raw.amountCents),
      });
      const label = `hostile case ${i}: ${JSON.stringify(raw, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`;
      const intentId = await proposeRaw(agent, raw);
      const stored = await outsider.getIntent(intentId);
      expect(stored?.status, label).toBe(expected.verdict);
      expect(stored?.amountCents ?? null, label).toBe(hugeAmount ? null : Number(raw.amountCents));
      if (hugeAmount) expect(stored?.outOfRange?.["amountCents"], label).toBe(raw.amountCents.toString());
      count(`hostile ${expected.verdict}`);
      hostile += 1;
      if (expected.verdict === "approved" && rng.chance(0.5)) {
        await recordRandomResult(intentId, Number(raw.amountCents));
      }
    }

    async function recordRandomResult(intentId: number, amountCents: number): Promise<void> {
      const roll = rng.next();
      const filled = roll >= 0.15;
      const filledCents = !filled ? 0 : roll < 0.4 ? rng.int(0, amountCents) : amountCents;
      const pnlCents = filled ? rng.int(-Math.min(amountCents, 2_500), 1_000) : 0;
      await executor.recordResult({ intentId, filled, filledCents, pnlCents });
    }

    // Every rule fired several times, so agreement is meaningful.
    for (const key of [
      "approved",
      "needs_approval",
      "agent paused",
      "zero amount",
      "daily loss limit reached",
      "over max trade size",
      "category not allowed",
      "over budget",
    ]) {
      expect(
        verdictCounts[key] ?? 0,
        `${key} never happened: ${JSON.stringify(verdictCounts)}`,
      ).toBeGreaterThan(5);
    }

    // Random rules seldom approve a hostile proposal, so finish with some that must be approved: an
    // out-of-range price lands in an IntentApproved event, and a result is recorded on one of them.
    await user.setPolicy({
      ...(await user.getRules()),
      paused: false,
      allowedCategories: ALL_CATEGORIES_MASK,
      dailyLossCents: 0,
      approvalAboveCents: 0,
      maxTradeCents: 2_500,
      budgetCents: snapshot.committedCents + 10_000,
    });
    snapshot = await user.getSnapshot();
    const base = { market: "GEMI-FUZZ-END", category: 0, outcome: "NO", isBuy: false, amountCents: 100n };
    const pinned = [
      await proposeRaw(agent, { ...base, limitPrice: 2n ** 256n - 1n }),
      await proposeRaw(agent, { ...base, isBuy: true, limitPrice: 2n ** 53n }),
      await proposeRaw(agent, { ...base, market: "", outcome: "MAYBE", limitPrice: 0n }),
    ];
    for (const id of pinned) expect((await outsider.getIntent(id))?.status).toBe("approved");
    await executor.recordResult({ intentId: pinned[1] ?? -1, filled: true, filledCents: 40, pnlCents: -40 });
    hostile += pinned.length;

    // The reducer rebuilds the contract's state from its events (plus getIntent for missing details).
    const events = await outsider.getEvents({ fromBlock: chain.deployBlock });
    const state = reduceEvents(events);
    snapshot = await user.getSnapshot();
    expect(state.rules).toEqual(snapshot.rules);
    expect(policyStateAt(state, snapshot.blockTimestamp)).toEqual({
      committedCents: snapshot.committedCents,
      lossTodayCents: snapshot.lossTodayCents,
    });
    const fromEvents = await intentsFromEvents(state, outsider);
    expect(fromEvents).toEqual(await user.getIntents());
    expect(fromEvents).toHaveLength(CASES + pinned.length);
    // Hostile intents were in the log the whole time, including approved ones with out-of-range prices.
    expect(hostile).toBeGreaterThan(20);
    expect(fromEvents.filter((intent) => intent["outOfRange"] !== undefined).length).toBeGreaterThan(10);
  });
});
