import { describe, expect, it } from "vitest";

import { countFills, fillOutcome, fillWords, type JournalOrder } from "../src";

const order = (
  state: JournalOrder["state"],
  filledHundredths: number,
  filledCents: number,
): JournalOrder => ({
  environment: "sandbox",
  state,
  quantityHundredths: 1_250,
  filledHundredths,
  filledCents,
});

describe("how a fill reads", () => {
  it("a partly filled order: what filled of what was placed and of the amount, and that the rest was released", () => {
    const outcome = fillOutcome(
      { status: "executed", amountCents: 263, filledCents: 105 },
      order("partly_filled", 500, 105),
    );
    expect(fillWords(outcome)).toEqual({
      label: "Partly filled",
      sentence:
        "Partly filled: 5 of 12.50 contracts, $1.05 of $2.63. The rest was cancelled and its budget released.",
      step: "Partly filled",
      detail: "5 of 12.50 contracts, $1.05 of $2.63. The rest was cancelled and its budget released.",
    });
  });

  it("counts what the contract recorded, not the journal's figure, when both are there", () => {
    const outcome = fillOutcome(
      { status: "executed", amountCents: 263, filledCents: 104 },
      order("partly_filled", 500, 105),
    );
    expect(fillWords(outcome)?.sentence).toContain("$1.04 of $2.63");
  });

  it("a fill at the venue not yet recorded onchain: says so instead of a bare Approved", () => {
    const filled = fillOutcome(
      { status: "approved", amountCents: 263, filledCents: null },
      order("filled", 1_250, 263),
    );
    expect(fillWords(filled)).toEqual({
      label: "Filled at Gemini sandbox",
      sentence: "Filled at Gemini sandbox; recording the result onchain.",
      step: "Filled at Gemini sandbox; recording the result onchain",
      detail:
        "The executor records the result onchain next; until then the budget still holds the full amount.",
    });
    const partly = fillOutcome(
      { status: "approved", amountCents: 263, filledCents: null },
      { ...order("partly_filled", 500, 105), environment: "production" },
    );
    expect(fillWords(partly)?.sentence).toBe(
      "Partly filled at Gemini (5 of 12.50 contracts); recording the result onchain.",
    );
  });

  it("reads exactly as the status without a journal row (the simulated venue), or when the journal agrees", () => {
    const intents = [
      { status: "executed", amountCents: 980, filledCents: 980 },
      { status: "approved", amountCents: 980, filledCents: null },
      { status: "failed", amountCents: 980, filledCents: null },
    ] as const;
    for (const intent of intents) {
      expect(fillWords(fillOutcome(intent, null))).toBeNull();
      expect(fillWords(fillOutcome(intent, undefined))).toBeNull();
    }
    expect(fillWords(fillOutcome(intents[0], order("filled", 1_250, 263)))).toBeNull();
    expect(fillWords(fillOutcome(intents[1], order("open", 0, 0)))).toBeNull();
  });

  it("a failed intent says why it did not fill when the executor or the venue said so", () => {
    const failed = { status: "failed", amountCents: 980, filledCents: 0 } as const;
    expect(fillWords(fillOutcome(failed, null, ["Gemini does not list this market"]))).toEqual({
      label: "Not filled",
      sentence:
        "Not filled: the executor refused it before sending any order, because Gemini does not list this market. Its amount went back to the budget.",
      step: "Refused by the executor",
      detail:
        "The executor refused it before sending any order, because Gemini does not list this market. Its amount went back to the budget.",
    });
    expect(
      fillWords(
        fillOutcome(failed, {
          ...order("rejected", 0, 0),
          detail: "Gemini's sandbox refused the order: InsufficientFunds",
        }),
      )?.sentence,
    ).toBe(
      "Not filled: Gemini's sandbox refused the order: InsufficientFunds. Its amount went back to the budget.",
    );
    expect(fillWords(fillOutcome(failed, order("rejected", 0, 0)))?.sentence).toBe(
      "Not filled: Gemini sandbox refused the order. Its amount went back to the budget.",
    );
    expect(fillWords(fillOutcome(failed, order("cancelled", 0, 0)))).toEqual({
      label: "Not filled",
      sentence:
        "Not filled: the order rested on Gemini sandbox and was cancelled with nothing filled. Its amount went back to the budget.",
      step: "Did not fill",
      detail:
        "The order rested on Gemini sandbox and was cancelled with nothing filled. Its amount went back to the budget.",
    });
    // Flags never apply to an intent that was not refused, and a failed intent with nothing said reads as today.
    expect(fillWords(fillOutcome(failed, null))).toBeNull();
    expect(
      fillWords(fillOutcome({ status: "rejected", amountCents: 980, filledCents: null }, null, ["x"])),
    ).toBeNull();
  });

  it("counts executed intents in full and in part, each once", () => {
    expect(
      countFills([
        {
          intent: { status: "executed", amountCents: 263, filledCents: 105 },
          order: order("partly_filled", 500, 105),
        },
        {
          intent: { status: "executed", amountCents: 263, filledCents: 263 },
          order: order("filled", 1_250, 263),
        },
        { intent: { status: "executed", amountCents: 980, filledCents: 980 }, order: null },
        {
          intent: { status: "failed", amountCents: 980, filledCents: null },
          order: order("cancelled", 0, 0),
        },
      ]),
    ).toEqual({ filled: 2, partlyFilled: 1 });
  });
});
