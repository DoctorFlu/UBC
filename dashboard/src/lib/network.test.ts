import { describe, expect, it } from "vitest";

import type { ChainView, SettlementView, VenueOrderView } from "@/lib/live/types";

import { contractFillSource, fillSource, fillsSource } from "./network";

type Fills = Pick<ChainView, "venue" | "venueOrders" | "settlements">;

const LOCAL = { kind: "local" } as const;
const ARC = { kind: "arc-testnet" } as const;
const announced = (venue: "simulated" | "gemini", environment: "sandbox" | "production" | null = null) => ({
  venue: { venue, environment, announcedAt: "2026-11-17T20:00:00.000Z" },
});
const order = (environment: "sandbox" | "production") =>
  ({ venue: "gemini", environment }) as unknown as VenueOrderView;
const settled = (venue: "simulated" | "gemini") =>
  ({ status: "verified", document: { venue } }) as unknown as SettlementView;

function chain(patch: Partial<Fills> = {}): Fills {
  return { venue: null, venueOrders: {}, settlements: {}, ...patch };
}

/**
 * The contract records a fill however it came about, so where it came from is what the executor signed:
 * the chain (local or Arc) only decides when the executor has said nothing at all.
 */
describe("where a fill came from", () => {
  it("is simulated on Arc when the executor announced the simulated venue", () => {
    expect(fillSource(chain(announced("simulated")), ARC, 0)).toBe("simulated");
    expect(contractFillSource(chain(announced("simulated")), ARC)).toBe("simulated");
  });

  it("is unknown on Arc until the executor says, and simulated on a silent local devchain", () => {
    expect(fillSource(chain(), ARC, 0)).toBe("unknown");
    expect(contractFillSource(chain(), ARC)).toBe("unknown");
    expect(fillSource(chain(), LOCAL, 0)).toBe("simulated");
    expect(contractFillSource(chain(), LOCAL)).toBe("simulated");
  });

  it("follows the order the executor journaled for the intent, whatever it announced later", () => {
    const fills = chain({ ...announced("simulated"), venueOrders: { 3: order("production") } });
    expect(fillSource(fills, LOCAL, 3)).toBe("live");
    expect(fillSource(chain({ venueOrders: { 3: order("sandbox") } }), ARC, 3)).toBe("sandbox");
  });

  it("takes a simulated settlement's word, and calls a Gemini fill with no journaled order unknown", () => {
    expect(
      fillSource(
        chain({ ...announced("gemini", "sandbox"), settlements: { 1: settled("simulated") } }),
        ARC,
        1,
      ),
    ).toBe("simulated");
    expect(fillSource(chain(announced("gemini", "sandbox")), ARC, 2)).toBe("unknown");
    expect(contractFillSource(chain(announced("gemini", "sandbox")), ARC)).toBe("sandbox");
    expect(contractFillSource(chain(announced("gemini", "production")), ARC)).toBe("live");
  });

  it("labels a total by the source that most qualifies any of its fills", () => {
    const fills = chain({ venueOrders: { 1: order("production"), 2: order("sandbox") } });
    expect(fillsSource(fills, ARC, [1])).toBe("live");
    expect(fillsSource(fills, ARC, [1, 2])).toBe("sandbox");
    expect(fillsSource(fills, ARC, [1, 2, 3])).toBe("unknown");
    expect(fillsSource(fills, LOCAL, [1, 2, 3])).toBe("simulated");
    expect(fillsSource(fills, ARC, [])).toBe("live");
  });
});
