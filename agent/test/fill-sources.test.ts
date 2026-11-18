import type { Intent } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { fillsText } from "../src/tools/get-activity";
import { intentRow } from "../src/support/intents";
import type { OrdersRead } from "../src/support/orders";

/**
 * Where the agent says a fill came from: as the console labels it, by the venue the executor announced
 * when the fill was mined, never by a later one (#23). A total of mixed fills says each source.
 */

const filled = (id: number) =>
  ({
    id,
    market: "GEMI-BTC2611200100-HI65000",
    category: 0,
    outcome: "NO",
    isBuy: true,
    amountCents: 500,
    limitPrice: 31,
    status: "executed",
    proposedAt: 1_800_000_000,
    filledCents: 500,
    pnlCents: 0,
  }) as unknown as Intent;

const switched: OrdersRead = {
  byIntent: new Map(),
  // The venue now is Gemini's sandbox: alone, it would call the earlier, order-less fill unknown.
  venue: { venue: "gemini", environment: "sandbox" },
  fillSources: new Map([
    [0, "simulated"],
    [1, "sandbox"],
  ]),
};

describe("a fill's source in the agent's answers", () => {
  it("takes each fill's source from the console, not from the venue announced now", () => {
    expect(intentRow(filled(0), undefined, undefined, undefined, undefined, switched).fillSource).toBe(
      "simulated",
    );
    expect(intentRow(filled(1), undefined, undefined, undefined, undefined, switched).fillSource).toBe(
      "sandbox",
    );
    // A fill the console did not label is unknown, never guessed from the venue now.
    expect(intentRow(filled(2), undefined, undefined, undefined, undefined, switched).fillSource).toBe(
      "unknown",
    );
  });

  it("falls back to the announced venue with a console from before the history", () => {
    const older: OrdersRead = {
      ...switched,
      venue: { venue: "simulated", environment: null },
      fillSources: null,
    };
    expect(intentRow(filled(0), undefined, undefined, undefined, undefined, older).fillSource).toBe(
      "simulated",
    );
  });

  it("says each source's count for a mixed total, and the one source otherwise", () => {
    expect(
      fillsText([{ fillSource: "simulated" }, { fillSource: "simulated" }, { fillSource: "sandbox" }]),
    ).toBe(
      "; fills by source: 2 simulated (no exchange saw those orders), 1 on Gemini's sandbox, with test funds",
    );
    expect(fillsText([{ fillSource: "simulated" }, { fillSource: null }])).toBe(
      "; simulated fills: no exchange saw those orders",
    );
    expect(fillsText([{ fillSource: "live" }])).toBe("");
  });
});
