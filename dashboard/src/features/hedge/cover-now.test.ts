import type { HedgePlan } from "@mandate/planner";
import type { IntentView } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import type { LadderQuotes } from "@/lib/hedge/types";

import { coverNow, coverSentence } from "./cover-now";

const TICKER = "BTC2611202200";
const symbol = (strike: number) => `GEMI-${TICKER}-HI${strike.toString()}`;

function quotes(spotCents: number): LadderQuotes {
  return {
    asset: "BTC",
    eventTicker: TICKER,
    title: "BTC price on November 20",
    expiry: "2026-11-20T22:00:00.000Z",
    spotCents,
    spotBasis: "mid",
    elsewhere: [],
    fetchedAt: "2026-11-17T02:07:00.000Z",
    rungs: [66_000, 65_500, 65_000, 64_500, 64_000, 63_500, 63_000, 62_500].map((k) => ({
      instrumentSymbol: symbol(k),
      strikeCents: k * 100,
      label: null,
      marketState: "open",
      noBuyCents: 40,
      yesBidCents: 58,
      yesAskCents: 60,
    })),
  };
}

const plan: Pick<
  HedgePlan,
  "asset" | "eventTicker" | "floorCents" | "ceilingCents" | "spotCents" | "holdingQuantity"
> = {
  asset: "BTC",
  eventTicker: TICKER,
  floorCents: 6_300_000,
  ceilingCents: 6_466_000,
  spotCents: 6_466_000,
  holdingQuantity: "0.05",
};

function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a cover");
  return value;
}

let nextId = 0;
function intent(
  strike: number,
  amountCents: number,
  limitPrice: number,
  status: IntentView["status"],
): IntentView {
  return {
    id: nextId++,
    status,
    reason: null,
    market: symbol(strike),
    category: 0,
    outcome: "NO",
    isBuy: true,
    amountCents,
    limitPrice,
    agent: null,
    contextHash: null,
    proposedAt: 0,
    filledCents: status === "executed" ? amountCents : null,
    pnlCents: null,
    proposedTxHash: `0x${"1".repeat(64)}`,
    decidedTxHash: null,
    resultTxHash: null,
  };
}

/** The hosted state from issue #88: two full ladders, every order filled. */
const hosted: IntentView[] = [
  intent(64_500, 315, 45, "executed"),
  intent(64_000, 1_000, 40, "executed"),
  intent(63_500, 875, 35, "executed"),
  intent(63_000, 775, 31, "executed"),
  intent(64_500, 408, 51, "executed"),
  intent(64_000, 1_075, 43, "executed"),
  intent(63_500, 900, 36, "executed"),
  intent(63_000, 775, 31, "executed"),
];

describe("cover now", () => {
  it("reads the hosted state from issue #88 as covered, in plain words", () => {
    const cover = coverNow({ plan, holdingQuantity: "0.05", quotes: quotes(6_466_000), intents: hosted });
    expect(cover?.assessment).toMatchObject({
      state: "met",
      heldPayoutCents: 16_500,
      targetPayoutCents: 8_300,
    });
    expect(coverSentence(must(cover).assessment, "Nov 20, 22:00 UTC")).toBe(
      "Covered. If BTC settles below $63,000 on Nov 20, 22:00 UTC, the contracts you hold pay $165, more than the $83 your 0.05 BTC loses from today's $64,660 down to $63,000. Nothing more is needed.",
    );
  });

  it("counts an order waiting for the owner, and says what a new plan would add", () => {
    const intents = [intent(64_500, 315, 45, "executed"), intent(64_000, 1_000, 40, "needs_approval")];
    const cover = coverNow({ plan, holdingQuantity: "0.05", quotes: quotes(6_464_000), intents });
    expect(cover?.assessment).toMatchObject({
      state: "partly_met",
      heldByState: { filled: 700, awaiting_fill: 0, awaiting_owner: 2_500 },
      missingPayoutCents: 5_000,
    });
    expect(coverSentence(must(cover).assessment, null)).toBe(
      "Partly covered. If BTC settles below $63,000, the contracts you hold and your pending orders pay $32, 39% of the $82 your 0.05 BTC loses from today's $64,640 down to $63,000. A new plan buys only the missing $50.",
    );
  });

  it("ignores rejected intents and other ladders, and says when nothing is held", () => {
    const intents = [
      intent(64_000, 1_000, 40, "rejected"),
      { ...intent(64_000, 1_000, 40, "executed"), market: "GEMI-BTC2611272200-HI64000" },
    ];
    const cover = coverNow({ plan, holdingQuantity: null, quotes: quotes(6_464_000), intents });
    expect(cover?.assessment.state).toBe("not_met");
    expect(coverSentence(must(cover).assessment, null)).toBe(
      "Not covered. No contract you hold pays if BTC settles below $63,000, against the $82 your 0.05 BTC loses from today's $64,640 down to $63,000.",
    );
  });

  it("rounds prices in the sentence to whole dollars, keeping the cents of what is paid", () => {
    const offGrid = { ...plan, floorCents: 6_147_451, ceilingCents: null };
    const cover = coverNow({
      plan: offGrid,
      holdingQuantity: "0.05",
      quotes: quotes(6_471_001),
      intents: hosted,
    });
    expect(coverSentence(must(cover).assessment, null)).toMatch(
      /^Covered\. If BTC settles below \$62,500, the contracts you hold pay \$165, more than the \$[0-9.]+ your 0\.05 BTC loses from today's \$64,710 down to \$61,475\. Nothing more is needed\.$/,
    );
  });

  it("keeps a ceiling the agent set, and has no answer for quotes of another ladder", () => {
    const raised = { ...plan, ceilingCents: 6_500_000 };
    const cover = coverNow({ plan: raised, holdingQuantity: "0.05", quotes: quotes(6_464_000), intents: [] });
    expect(cover?.assessment.ceilingCents).toBe(6_500_000);
    expect(
      coverNow({
        plan,
        holdingQuantity: "0.05",
        quotes: { ...quotes(6_464_000), eventTicker: "OTHER" },
        intents: [],
      }),
    ).toBeNull();
  });

  it("counts the simulated venue's fill on a strike only production lists, and never drops it silently", () => {
    // After the switch to the sandbox: $64,250 is held from a simulated fill, and the sandbox's ladder
    // (`quotes`) does not list it. Production does (`elsewhere`).
    const held = [intent(64_250, 1_000, 40, "executed")];
    const elsewhere = [{ instrumentSymbol: symbol(64_250), strikeCents: 6_425_000 }];
    const counted = coverNow({
      plan,
      holdingQuantity: "0.05",
      quotes: { ...quotes(6_466_000), elsewhere },
      intents: held,
    });
    expect(must(counted).positions.map((p) => [p.instrumentSymbol, p.strikeCents])).toEqual([
      [symbol(64_250), 6_425_000],
    ]);
    expect(must(counted).assessment.heldPayoutCents).toBe(2_500);
    // Production could not be read: no cover is shown, rather than one that leaves the position out.
    expect(
      coverNow({
        plan,
        holdingQuantity: "0.05",
        quotes: { ...quotes(6_466_000), elsewhere: null },
        intents: held,
      }),
    ).toBeNull();
  });
});
