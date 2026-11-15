/**
 * Issue #31: the offchain rule evaluator must agree with the contract. For random policies, random state
 * (spend, losses, pause, day changes) and random intents, three answers must match:
 *   1. `evaluateIntent` in TypeScript,
 *   2. the contract's `previewTrade`,
 *   3. the verdict `proposeTrade` actually emits.
 * At the end, the event reducer must rebuild exactly the state the contract holds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES_MASK,
  evaluateIntent,
  fitsBudget,
  listIntents,
  policyStateAt,
  reduceEvents,
  SECONDS_PER_DAY,
  type Policy,
  type PolicySnapshot,
} from "@mandate/shared";
import { deployTestPolicy, seededRandom, startTestAnvil, type TestAnvil, type TestPolicy } from "./harness";

const SEED = 31_2026;
const CASES = 600;

describe("evaluateIntent agrees with the contract (fuzz)", () => {
  let anvil: TestAnvil;
  let chain: TestPolicy;

  beforeAll(async () => {
    anvil = await startTestAnvil();
    chain = await deployTestPolicy(anvil);
  });
  afterAll(async () => {
    await anvil.stop();
  });

  it(`finds no disagreement over ${CASES} random cases (seed ${SEED})`, { timeout: 300_000 }, async () => {
    const rng = seededRandom(SEED);
    const { owner, agent, executor, outsider } = chain;
    const verdictCounts: Record<string, number> = {};
    let snapshot: PolicySnapshot = await owner.getSnapshot();

    /** A policy whose limits sit near the current spend and loss, so both sides of each rule get hit. */
    const randomPolicy = (): Policy => ({
      budgetCents: Math.max(0, snapshot.spentCents + rng.int(-2_000, 6_000)),
      maxTradeCents: rng.int(0, 4_000),
      allowedCategories: rng.chance(0.2) ? ALL_CATEGORIES_MASK : rng.int(0, ALL_CATEGORIES_MASK),
      approvalAboveCents: rng.chance(0.4) ? 0 : rng.int(0, 3_000),
      dailyLossCents: rng.chance(0.3) ? 0 : Math.max(0, snapshot.lossTodayCents + rng.int(-1_500, 3_000)),
      paused: rng.chance(0.08),
    });

    /** Amounts cluster around the current limits to probe off-by-one boundaries. */
    const randomAmount = (policy: Policy): number => {
      const remaining = Math.max(1, policy.budgetCents - snapshot.spentCents);
      const anchor = rng.pick([
        policy.maxTradeCents,
        policy.approvalAboveCents,
        remaining,
        rng.int(1, 4_000),
      ]);
      return Math.max(1, anchor + rng.pick([-1, 0, 1, rng.int(-500, 500)]));
    };

    await owner.setPolicy(randomPolicy());
    snapshot = await owner.getSnapshot();

    for (let i = 0; i < CASES; i++) {
      // Mutate policy and time now and then.
      if (rng.chance(0.15)) await owner.setPolicy(randomPolicy());
      else if (rng.chance(0.04)) await owner.setPaused(!snapshot.policy.paused);
      if (rng.chance(0.03)) await anvil.advanceTime(SECONDS_PER_DAY);
      snapshot = await owner.getSnapshot();

      const intent = {
        market: `GEMI-FUZZ-${i}`,
        category: rng.int(0, 6),
        outcome: rng.chance(0.5) ? ("YES" as const) : ("NO" as const),
        isBuy: rng.chance(0.75),
        amountCents: randomAmount(snapshot.policy),
        limitPrice: rng.int(1, 99),
      };
      const label = `case ${i}: ${JSON.stringify({ intent, snapshot })}`;

      // 1 vs 2: TypeScript mirror against previewTrade.
      const expected = evaluateIntent(snapshot.policy, snapshot, intent);
      expect(await outsider.previewTrade(intent), label).toEqual(expected);

      // Categories above 6 cannot be proposed through the schema, but the rule must still agree.
      const oddCategory = { ...intent, category: rng.int(7, 255) };
      expect(await outsider.previewTrade(oddCategory), label).toEqual(
        evaluateIntent(snapshot.policy, snapshot, oddCategory),
      );

      // 1 vs 3: TypeScript mirror against the verdict the real transaction emits.
      const result = await agent.proposeTrade(intent);
      const { intentId, txHash: _tx, blockNumber: _block, ...verdict } = result;
      expect(verdict, label).toEqual(expected);
      verdictCounts[expected.verdict === "rejected" ? expected.reason : expected.verdict] =
        (verdictCounts[expected.verdict === "rejected" ? expected.reason : expected.verdict] ?? 0) + 1;

      // Drive state forward: owner decisions and executor results.
      if (result.verdict === "needs_approval") {
        if (rng.chance(0.6)) {
          const now = await owner.getSnapshot();
          const fits = !intent.isBuy || fitsBudget(now.policy, now, intent.amountCents);
          const decision = await owner.approveIntent(intentId);
          expect(decision.verdict, `${label} approveIntent`).toBe(fits ? "approved" : "rejected");
          if (decision.verdict === "approved") await recordRandomResult(intentId, intent.amountCents);
        } else if (rng.chance(0.75)) {
          await owner.rejectIntent(intentId);
        }
      } else if (result.verdict === "approved" && rng.chance(0.85)) {
        await recordRandomResult(intentId, intent.amountCents);
      }
    }

    async function recordRandomResult(intentId: number, amountCents: number): Promise<void> {
      const roll = rng.next();
      const filled = roll >= 0.15;
      const filledCents = !filled ? 0 : roll < 0.4 ? rng.int(0, amountCents) : amountCents;
      const pnlCents = filled ? rng.int(-Math.min(amountCents, 2_500), 1_000) : 0;
      await executor.recordResult({ intentId, filled, filledCents, pnlCents });
    }

    // Every rule fired at least once, so agreement is meaningful.
    for (const key of [
      "approved",
      "needs_approval",
      "PAUSED",
      "CATEGORY_NOT_ALLOWED",
      "OVER_MAX_TRADE",
      "OVER_BUDGET",
      "DAILY_LOSS_LIMIT",
    ]) {
      expect(
        verdictCounts[key] ?? 0,
        `${key} never happened: ${JSON.stringify(verdictCounts)}`,
      ).toBeGreaterThan(5);
    }

    // The reducer rebuilds the contract's state from its events alone.
    const events = await outsider.getEvents({ fromBlock: chain.deployBlock });
    const state = reduceEvents(events);
    snapshot = await owner.getSnapshot();
    expect(state.policy).toEqual(snapshot.policy);
    expect(policyStateAt(state, snapshot.blockTimestamp)).toEqual({
      spentCents: snapshot.spentCents,
      lossTodayCents: snapshot.lossTodayCents,
    });
    const fromEvents = listIntents(state).map(
      ({ proposedTxHash: _p, decidedTxHash: _d, resultTxHash: _r, ...intent }) => intent,
    );
    expect(fromEvents).toEqual(await owner.getIntents());
    expect(fromEvents).toHaveLength(CASES);
  });
});
