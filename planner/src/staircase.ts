/**
 * The staircase a protection goal calls for, before prices, limits or positions already held: where
 * protection starts and stops, and how many NO contracts each strike needs. `planHedge` buys it and
 * `assessCover` measures positions against it, so both always mean the same goal.
 */
import type { LadderRung } from "@mandate/gemini";
import type { ProtectionGoal, WarningCode } from "./types";
import {
  floorDiv,
  formatPrice,
  formatUsd,
  HOLDING_SCALE,
  holdingCents,
  PlannerInputError,
  requireInteger,
} from "./units";

/** The strikes a staircase is built on. A full `LadderRung` fits. */
export type StrikeRung = Pick<LadderRung, "instrumentSymbol" | "strikeCents">;

export interface DesignedRung<R extends StrikeRung = LadderRung> {
  rung: R;
  coversFromCents: number;
  coversToCents: number;
  designedHundredths: number;
}

export type Warn = (code: WarningCode, message: string) => void;

export function resolveFloor(goal: ProtectionGoal, spotCents: number): number {
  if ("floorCents" in goal) {
    requireInteger(goal.floorCents, "goal.floorCents", 1);
    return goal.floorCents;
  }
  const bps = Math.round(goal.dropPercent * 100);
  if (
    !Number.isFinite(goal.dropPercent) ||
    bps <= 0 ||
    bps >= 10_000 ||
    Math.abs(goal.dropPercent * 100 - bps) > 1e-6
  ) {
    throw new PlannerInputError("goal.dropPercent must be between 0 and 100 with at most two decimals");
  }
  // spot x (1 - drop), rounded half up to the cent.
  return Number(floorDiv(BigInt(spotCents) * BigInt(10_000 - bps) + 5_000n, 10_000n));
}

/**
 * Where protection starts: spot by default, or the requested ceiling lowered to at most the first
 * strike at or above spot. Null when no strike lies below spot and no ceiling was asked for.
 */
export function resolveCeiling(
  units: bigint,
  spotCents: number,
  requested: number | undefined,
  ascending: readonly StrikeRung[],
  warn: Warn,
): number | null {
  const firstAtOrAbove = ascending.find((r) => r.strikeCents >= spotCents)?.strikeCents;
  const highestAllowed = firstAtOrAbove ?? spotCents;
  let ceiling: number;
  if (requested === undefined) {
    if (!ascending.some((r) => r.strikeCents < spotCents)) {
      warn(
        "no_strike_below_spot",
        `Every strike on this ladder is at or above spot (${formatPrice(spotCents)}), so it cannot protect against a fall.`,
      );
      return null;
    }
    // Protect the holding's actual loss: the top rung is the highest strike below spot, sized
    // for the drop from spot to that strike.
    ceiling = spotCents;
  } else {
    requireInteger(requested, "goal.ceilingCents", 1);
    ceiling = requested;
    if (ceiling > highestAllowed) {
      warn(
        "ceiling_lowered",
        `Protection cannot start at ${formatPrice(requested)}, more than one strike above spot; it starts at ${formatPrice(highestAllowed)} instead.`,
      );
      ceiling = highestAllowed;
    }
  }
  if (ceiling > spotCents) {
    const excess = holdingCents(units, ceiling - spotCents);
    warn(
      "ceiling_above_spot",
      `Protection starts at ${formatPrice(ceiling)}, above spot (${formatPrice(spotCents)}), so the payout can exceed the holding's actual loss by up to ${formatUsd(excess)}.`,
    );
  }
  return ceiling;
}

/**
 * Walks the strikes below the ceiling from the top: the rung at K_i buys q x (K_{i-1} - max(K_i, F))
 * contracts, rounded down to 0.01, and the last rung is the first strike at or below the floor.
 * `tailFromCents` is the lowest strike reached when no strike lies at or below the floor.
 */
export function designStaircase<R extends StrikeRung>(
  units: bigint,
  descending: readonly R[],
  ceilingCents: number,
  floorCents: number,
): { designed: DesignedRung<R>[]; tailFromCents: number | null } {
  const designed: DesignedRung<R>[] = [];
  let previous = ceilingCents;
  for (const rung of descending) {
    if (rung.strikeCents >= ceilingCents) continue;
    const bottom = Math.max(rung.strikeCents, floorCents);
    const gap = previous - bottom;
    if (gap <= 0) break;
    designed.push({
      rung,
      coversFromCents: previous,
      coversToCents: bottom,
      // q x gap dollars, in hundredths of a contract: units x gapCents / 1e8, rounded down.
      designedHundredths: Number(floorDiv(units * BigInt(gap), HOLDING_SCALE)),
    });
    previous = rung.strikeCents;
    if (rung.strikeCents <= floorCents) break;
  }
  return { designed, tailFromCents: previous > floorCents ? previous : null };
}
