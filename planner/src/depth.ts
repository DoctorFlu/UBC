/**
 * How much of a rung's NO side a plan can take, and at what limit price.
 *
 * `slippageCents` is how many cents above the rung's NO price (`noBuyCents`, the listing's quote) the
 * owner lets a plan pay. With slippage above 0 and the book's levels known (`depth.noOffers`), the plan
 * takes every level priced at or below `min(99, noBuyCents + slippage)`, cheapest first, and only as
 * many contracts as the goal still needs; the limit is the price of the deepest level it uses, so an
 * order commits no more than the book requires. At slippage 0, with the depth given by hand
 * (`depthHundredths`), or without the book's levels, a rung is sized as before: the top of the book
 * (`depth.noBuyHundredths`, unlimited when unknown) at `min(99, noBuyCents + slippage)`.
 */
import type { LadderRung } from "@mandate/gemini";

import { ceilDiv } from "./units";

/** What one rung can buy at a slippage: how much is offered, and the limit and expected cost of a size. */
export interface RungOffer {
  /** Contracts offered within the slippage, or undefined when unknown (no book): treated as unlimited. */
  availableHundredths: number | undefined;
  /** True when the book's levels were walked; false when the rung is sized by today's rule. */
  walked: boolean;
  /** The limit price for buying `hundredths` contracts (at most `availableHundredths`). */
  limitFor(hundredths: number): number;
  /** Levels `hundredths` contracts take, cheapest first (1 when the rung is not walked). */
  levelsFor(hundredths: number): number;
  /** What `hundredths` contracts cost if they fill at the prices the book showed, rounded up to the cent. */
  expectedFillFor(hundredths: number): number;
}

/**
 * The offer of one priced rung (`noBuyCents` between 1 and 99) at a slippage. `override` is the depth
 * given by hand for this rung (`HedgeInput.depthHundredths`), which wins and is never walked.
 */
export function rungOffer(rung: LadderRung, slippageCents: number, override: number | undefined): RungOffer {
  const best = rung.noBuyCents ?? 0;
  const ceiling = Math.min(99, best + slippageCents);
  const levels = rung.depth?.noOffers;
  if (override !== undefined || slippageCents === 0 || levels === undefined) {
    const availableHundredths = override ?? rung.depth?.noBuyHundredths;
    return {
      availableHundredths,
      walked: false,
      limitFor: () => ceiling,
      levelsFor: () => 1,
      expectedFillFor: (hundredths) => Number(ceilDiv(BigInt(hundredths) * BigInt(ceiling), 100n)),
    };
  }
  const within = levels.filter((level) => level.priceCents >= 1 && level.priceCents <= ceiling);
  const availableHundredths = within.reduce((sum, level) => sum + level.quantityHundredths, 0);
  /** The levels `hundredths` contracts take, cheapest first, each with the contracts taken from it. */
  const take = (hundredths: number) => {
    const taken: { priceCents: number; hundredths: number }[] = [];
    let left = hundredths;
    for (const level of within) {
      if (left <= 0) break;
      const size = Math.min(left, level.quantityHundredths);
      taken.push({ priceCents: level.priceCents, hundredths: size });
      left -= size;
    }
    return taken;
  };
  return {
    availableHundredths,
    walked: true,
    // The deepest level used: never rounded down, so the order reaches every contract it counts on.
    limitFor: (hundredths) => take(Math.max(1, hundredths)).at(-1)?.priceCents ?? ceiling,
    levelsFor: (hundredths) => take(hundredths).length,
    expectedFillFor: (hundredths) => {
      const hundredthCents = take(hundredths).reduce(
        (sum, level) => sum + BigInt(level.hundredths) * BigInt(level.priceCents),
        0n,
      );
      return Number(ceilDiv(hundredthCents, 100n));
    },
  };
}
