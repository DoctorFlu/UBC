import type { IntentView } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { fixtureContext } from "@/fixtures";
import { sampleHedgePlan } from "@/fixtures/samples";
import type { ChainView, SealedReason, VenueOrderView } from "@/lib/live/types";

import { executionSummary, intentsCitingPlan, planExecution } from "./execution";
import { readHedgePlan } from "./plan-schema";

const plan = sampleHedgePlan;
const [first, second] = plan.orders;

function intent(id: number, fields: Partial<IntentView>): IntentView {
  return {
    id,
    market: first?.instrumentSymbol ?? "",
    amountCents: first?.amountCents ?? 0,
    status: "approved",
    filledCents: null,
    ...fields,
  } as IntentView;
}

function sealed(planId: string, status: "verified" | "tampered" = "verified"): SealedReason {
  return { status, document: { ...fixtureContext, planId } } as unknown as SealedReason;
}

describe("planExecution", () => {
  it("says nothing reached the chain when no intent cites the plan", () => {
    const chain = { intents: [intent(0, {})], sealed: {} } as Pick<ChainView, "intents" | "sealed">;
    const execution = planExecution(plan, chain);
    expect(execution.proposed).toBe(0);
    expect(executionSummary(execution, plan.orders.length)).toBe(
      "Not executed: no intent on the chain cites this plan yet.",
    );
    expect(executionSummary(planExecution(plan, null), plan.orders.length)).toContain("Not executed");
    // Once its ladder has expired, it never will be: no "yet".
    expect(executionSummary(execution, plan.orders.length, true)).toBe(
      "Not executed: no intent on the chain cites this plan, and its ladder has expired.",
    );
  });

  it("matches orders by market and amount, only through verified sealed reasons", () => {
    const chain = {
      intents: [
        intent(0, { status: "executed", filledCents: first?.amountCents ?? 0 }),
        intent(1, {
          market: second?.instrumentSymbol ?? "",
          amountCents: second?.amountCents ?? 0,
          status: "needs_approval",
        }),
        // Cites the plan, but its document no longer matches its hash: not trusted.
        intent(2, { market: second?.instrumentSymbol ?? "", amountCents: second?.amountCents ?? 0 }),
        // Cites the plan without matching any order.
        intent(3, { amountCents: 1, status: "rejected" }),
      ],
      sealed: {
        0: sealed(plan.planId),
        1: sealed(plan.planId),
        2: sealed(plan.planId, "tampered"),
        3: sealed(plan.planId),
      },
    } as unknown as Pick<ChainView, "intents" | "sealed">;
    expect(intentsCitingPlan(chain, plan.planId).map((entry) => entry.id)).toEqual([0, 1, 3]);
    const execution = planExecution(plan, chain);
    expect(execution.orders.map((entry) => entry.intent?.id ?? null)).toEqual([0, 1, null, null]);
    expect(execution.extra.map((entry) => entry.id)).toEqual([3]);
    expect(execution.filledCents).toBe(first?.amountCents);
    expect(executionSummary(execution, plan.orders.length)).toBe(
      "2 of 4 orders proposed, 1 filled, 1 waiting for you, 1 rejected, and 1 other intent cites the plan without matching an order.",
    );
  });

  it("says how many filled only in part, by the executor's journal, each intent once", () => {
    const venueOrder = (state: VenueOrderView["state"], filledHundredths: number) =>
      ({
        venue: "gemini",
        environment: "sandbox",
        state,
        quantityHundredths: 1_250,
        filledHundredths,
        filledCents: 105,
      }) as VenueOrderView;
    const chain = {
      intents: [
        intent(0, { status: "executed", filledCents: 105 }),
        intent(1, {
          market: second?.instrumentSymbol ?? "",
          amountCents: second?.amountCents ?? 0,
          status: "executed",
          filledCents: second?.amountCents ?? 0,
        }),
      ],
      sealed: { 0: sealed(plan.planId), 1: sealed(plan.planId) },
      venueOrders: { 0: venueOrder("partly_filled", 500), 1: venueOrder("filled", 1_250) },
    } as unknown as Pick<ChainView, "intents" | "sealed" | "venueOrders">;
    const execution = planExecution(plan, chain);
    expect(execution.partlyFilled).toBe(1);
    expect(execution.orders[0]?.venueOrder?.state).toBe("partly_filled");
    expect(executionSummary(execution, plan.orders.length)).toBe(
      "2 of 4 orders proposed, 1 filled, 1 partly filled.",
    );
    // Without the journal (the simulated venue), as before.
    const simulated = planExecution(plan, { intents: chain.intents, sealed: chain.sealed });
    expect(executionSummary(simulated, plan.orders.length)).toBe("2 of 4 orders proposed, 2 filled.");
  });
});

describe("readHedgePlan", () => {
  it("reads a planner plan back exactly, and refuses a document that is not one", () => {
    expect(readHedgePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(readHedgePlan({ ...plan, orders: [{ ...first, quantityHundredths: 1.5 }] })).toBeNull();
    expect(readHedgePlan({ planId: plan.planId })).toBeNull();
  });
});
