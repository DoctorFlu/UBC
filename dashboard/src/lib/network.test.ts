import { describe, expect, it } from "vitest";

import type { ChainView, SettlementView, VenueAnnouncementView, VenueOrderView } from "@/lib/live/types";

import { announcementInForce, contractFillSource, fillShares, fillSource } from "./network";

type Fills = Pick<ChainView, "venue" | "venues" | "venueOrders" | "settlements" | "events">;

const LOCAL = { kind: "local" } as const;
const ARC = { kind: "arc-testnet" } as const;

const announcement = (
  venue: "simulated" | "gemini",
  environment: "sandbox" | "production" | null = null,
  holdsFromBlock: number | null = null,
): VenueAnnouncementView => ({
  holdsFromBlock,
  announced: { venue, environment, announcedAt: "2026-11-17T20:00:00.000Z" },
});
/** A history of announcements; the last is the one in force now. */
const announced = (...venues: VenueAnnouncementView[]): Pick<Fills, "venue" | "venues"> => ({
  venue: venues.at(-1)?.announced ?? null,
  venues,
});
const order = (environment: "sandbox" | "production") =>
  ({ venue: "gemini", environment }) as unknown as VenueOrderView;
const settled = (venue: "simulated" | "gemini") =>
  ({ status: "verified", document: { venue } }) as unknown as SettlementView;
/** Intent `intentId`'s fill, mined in `block`. */
const filled = (intentId: number, block: number) =>
  ({ type: "ResultRecorded", intentId, blockNumber: block }) as unknown as ChainView["events"][number];

function chain(patch: Partial<Fills> = {}): Fills {
  return { venue: null, venues: [], venueOrders: {}, settlements: {}, events: [], ...patch };
}

/**
 * The contract records a fill however it came about, so where it came from is what the executor signed:
 * the chain (local or Arc) only decides when the executor has said nothing at all.
 */
describe("where a fill came from", () => {
  it("is simulated on Arc when the executor announced the simulated venue", () => {
    expect(fillSource(chain(announced(announcement("simulated"))), ARC, 0)).toBe("simulated");
    expect(contractFillSource(chain(announced(announcement("simulated"))), ARC)).toBe("simulated");
  });

  it("is unknown on Arc until the executor says, and simulated on a silent local devchain", () => {
    expect(fillSource(chain(), ARC, 0)).toBe("unknown");
    expect(contractFillSource(chain(), ARC)).toBe("unknown");
    expect(fillSource(chain(), LOCAL, 0)).toBe("simulated");
    expect(contractFillSource(chain(), LOCAL)).toBe("simulated");
  });

  it("follows the order the executor journaled for the intent, whatever it announced later", () => {
    const fills = chain({ ...announced(announcement("simulated")), venueOrders: { 3: order("production") } });
    expect(fillSource(fills, LOCAL, 3)).toBe("live");
    expect(fillSource(chain({ venueOrders: { 3: order("sandbox") } }), ARC, 3)).toBe("sandbox");
  });

  it("takes a simulated settlement's word, and calls a Gemini fill with no journaled order unknown", () => {
    const sandbox = announced(announcement("gemini", "sandbox"));
    expect(fillSource(chain({ ...sandbox, settlements: { 1: settled("simulated") } }), ARC, 1)).toBe(
      "simulated",
    );
    expect(fillSource(chain(sandbox), ARC, 2)).toBe("unknown");
    expect(contractFillSource(chain(sandbox), ARC)).toBe("sandbox");
    expect(contractFillSource(chain(announced(announcement("gemini", "production"))), ARC)).toBe("live");
  });
});

/** The hosted demo's switch: simulated fills, then the executor announces Gemini's sandbox. */
describe("a fill keeps the source announced when it was mined", () => {
  const history = announced(announcement("simulated"), announcement("gemini", "sandbox", 100));
  const switched = chain({
    ...history,
    events: [filled(0, 40), filled(1, 99), filled(2, 100), filled(3, 120)],
    venueOrders: { 3: order("sandbox") },
  });

  it("labels fills before the switch by the earlier announcement, and the new venue applies only after", () => {
    // The first announcement covers the contract's earlier fills too.
    expect(fillSource(switched, ARC, 0)).toBe("simulated");
    expect(fillSource(switched, ARC, 1)).toBe("simulated");
    // At and after its first block, a Gemini fill with no journaled order is unknown, never simulated.
    expect(fillSource(switched, ARC, 2)).toBe("unknown");
    expect(fillSource(switched, ARC, 3)).toBe("sandbox");
    expect(contractFillSource(switched, ARC)).toBe("sandbox");
  });

  it("says each source's share of a mixed total, and one share when they agree", () => {
    expect(fillShares(switched, ARC, [0, 1, 3])).toEqual([
      { source: "simulated", count: 2 },
      { source: "sandbox", count: 1 },
    ]);
    expect(fillShares(switched, ARC, [0, 1])).toEqual([{ source: "simulated", count: 2 }]);
    expect(fillShares(switched, ARC, [])).toEqual([]);
    const live = chain({ venueOrders: { 1: order("production"), 2: order("sandbox") } });
    expect(fillShares(live, ARC, [1, 2, 9])).toEqual([
      { source: "unknown", count: 1 },
      { source: "sandbox", count: 1 },
      { source: "live", count: 1 },
    ]);
  });

  it("calls a fill unknown when the announcement in force no longer verifies, even on a local devchain", () => {
    const tampered = chain({
      venue: null,
      venues: [announcement("simulated"), { holdsFromBlock: 100, announced: null }],
      events: [filled(0, 40), filled(1, 150)],
    });
    expect(fillSource(tampered, LOCAL, 0)).toBe("simulated");
    expect(fillSource(tampered, LOCAL, 1)).toBe("unknown");
  });

  it("goes by a lone announcement when the fill's block is unknown, and by none among several", () => {
    const lone = [announcement("simulated")];
    expect(announcementInForce(lone, null)).toBe(lone[0]);
    expect(announcementInForce(history.venues, null)).toBeNull();
    expect(fillSource(chain(history), ARC, 7)).toBe("unknown");
    expect(announcementInForce([], 5)).toBeNull();
  });
});
