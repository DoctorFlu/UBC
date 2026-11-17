/**
 * The venue seam: everything the executor asks of the place orders trade, behind one interface, so the
 * executor's rules (check, place, follow, record, settle) are the same whatever fills the order.
 *
 * - `simulatedVenue` places nothing. It fills every order in full at once, and reads listings and
 *   outcomes from Gemini's public market data.
 * - `geminiVenue` (gemini-venue.ts, issue #93) places a limit order on Gemini, follows it until it is
 *   done, and reads the outcome from the account's settled positions, checked against the public one.
 */
import { findInstrument, type GeminiClient } from "@mandate/gemini";
import {
  categoryFromGemini,
  contractsBought,
  payoutFor,
  type CategoryId,
  type Resolution,
  type SettlementVenue,
} from "@mandate/shared";

/** The order for one approved intent, with numbers already checked to fit. */
export interface VenueOrder {
  intentId: number;
  market: string;
  outcome: "YES" | "NO";
  isBuy: boolean;
  /** At most this much money: the intent's approved amount. */
  amountCents: number;
  /** Cents per $1 contract, 1 to 99. */
  limitPrice: number;
}

/** An order the venue accepted. */
export interface PlacedOrder {
  order: VenueOrder;
  /** The venue's own id for it. */
  venueOrderId: string;
}

/**
 * What came of asking the venue to place an order:
 * - `placed`: the venue holds it (now, or from an earlier attempt); follow it with `readFill`.
 * - `refused`: the venue refused this order itself (an invalid order, not enough money). Final: record it
 *   as not filled, with the reason.
 * - `held`: nothing to record yet. The venue could not take orders for a reason that is not the order's
 *   (the key, the terms, the account), or it is finding out whether an earlier attempt reached it. Ask
 *   again later; the venue never sends an order twice.
 */
export type Placement =
  | { status: "placed"; placed: PlacedOrder }
  | { status: "refused"; detail: string }
  | { status: "held"; detail: string };

/**
 * Where an order stands. `open`: it may still fill, ask again later. `closed`: it will not change again
 * (filled, partly filled and then cancelled or expired, or refused), with what filled and why it closed.
 */
export type FillState =
  { state: "open"; filledCents: number } | { state: "closed"; filledCents: number; detail: string };

/** A filled position, as the executor asks about its outcome. */
export interface HeldPosition {
  intentId: number;
  market: string;
  outcome: "YES" | "NO";
  /** What the fill cost, as recorded onchain. */
  costCents: number;
  limitPrice: number;
}

/**
 * What became of a position's market:
 * - `open`: it trades until `expiresAt`; nothing to settle before then.
 * - `awaiting`: it expired, but the venue has not published the outcome. Ask again later, never guess.
 * - `unlisted`: the venue lists no such market any more. Ask again later.
 * - `resolved`: the venue published the outcome, and this is what the position paid. `venue` names the venue
 *   that filled it when that is not this one (a fill from before the executor changed venue).
 * - `disputed`: two of the venue's own sources disagree about the outcome or the position. Never settled
 *   while they do; the venue reports it, and the executor asks again later.
 */
export type PositionOutcome =
  | { status: "open"; expiresAt: string }
  | { status: "awaiting"; expiresAt: string | null }
  | { status: "unlisted" }
  | {
      status: "resolved";
      eventTicker: string;
      strikeCents: number | null;
      expiresAt: string;
      resolution: Resolution;
      resolvedAt: string;
      settlementValue: string | null;
      contractsHundredths: number;
      payoutCents: number;
      venue?: SettlementVenue;
    }
  | { status: "disputed"; detail: string };

export interface Venue {
  readonly kind: SettlementVenue;
  /**
   * The mandate category of the event that lists `instrumentSymbol`, or null when the venue lists no such
   * instrument. Throws when the venue cannot be reached or answers with anything else.
   */
  categoryOf(instrumentSymbol: string): Promise<CategoryId | null>;
  /**
   * Places the order, or finds the one an earlier attempt placed: calling it again for the same intent
   * never places a second order. Throws when the venue (or the venue's journal) cannot be reached and
   * nothing was sent.
   */
  placeOrder(order: VenueOrder): Promise<Placement>;
  /** Where the order stands now. Throws when the venue cannot be reached. */
  readFill(placed: PlacedOrder): Promise<FillState>;
  /** What became of a filled position's market. Throws when the venue cannot be reached. */
  positionOutcome(position: HeldPosition): Promise<PositionOutcome>;
}

/** Options for the simulated venue. */
export interface SimulatedVenueOptions {
  /** Clock in milliseconds, for telling an open market from one waiting for its outcome. */
  now?: () => number;
}

/**
 * The SIMULATED venue: it places nothing and fills every order in full at its limit price. Listings and
 * outcomes come from Gemini's public market data, so a position settles exactly as the real market did:
 * NO contracts pay one cent per hundredth when Gemini resolves the market to "no", and nothing otherwise.
 */
export function simulatedVenue(
  client: Pick<GeminiClient, "getEvent">,
  options: SimulatedVenueOptions = {},
): Venue {
  const now = options.now ?? Date.now;
  return {
    kind: "simulated",
    async categoryOf(instrumentSymbol) {
      const found = await findInstrument((ticker) => client.getEvent(ticker), instrumentSymbol);
      return found === null ? null : categoryFromGemini(found.event.category ?? "");
    },
    placeOrder(order) {
      return Promise.resolve({
        status: "placed",
        placed: { order, venueOrderId: `simulated-${String(order.intentId)}` },
      });
    },
    readFill(placed) {
      return Promise.resolve({
        state: "closed",
        filledCents: placed.order.amountCents,
        detail: "simulated full fill",
      });
    },
    async positionOutcome(position) {
      const found = await findInstrument((ticker) => client.getEvent(ticker), position.market);
      if (found === null) return { status: "unlisted" };
      const { contract, event, eventTicker } = found;
      const expiresAt = contract.expiry ?? event.expiry;
      const side = contract.resolutionSide?.toLowerCase();
      if ((side === "yes" || side === "no") && expiresAt !== null) {
        const contractsHundredths = contractsBought(position.costCents, position.limitPrice);
        return {
          status: "resolved",
          eventTicker,
          strikeCents: contract.strike?.type === "above" ? contract.strike.valueCents : null,
          expiresAt: new Date(expiresAt).toISOString(),
          resolution: side,
          // Gemini publishes both; an outcome without a time is dated by the expiry it settled.
          resolvedAt: new Date(contract.resolvedAt ?? expiresAt).toISOString(),
          settlementValue: contract.settlementValue,
          contractsHundredths,
          payoutCents: payoutFor(position.outcome, side, contractsHundredths),
        };
      }
      if (expiresAt !== null && Date.parse(expiresAt) > now()) return { status: "open", expiresAt };
      return { status: "awaiting", expiresAt };
    },
  };
}
