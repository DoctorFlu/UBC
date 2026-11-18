/**
 * The Gemini venue (issue #93): places an approved intent's order on Gemini Prediction Markets, the
 * sandbox (test funds) unless production was enabled explicitly, follows it until it closes, and reads
 * what the position paid from the account's settled positions.
 *
 * Never two orders for one intent. Before an order is sent, its record ("placing") is written to the
 * order journal in the console; when that write fails, nothing is sent. Every later call for the intent
 * starts from the journal:
 * - an order Gemini holds is followed, never placed again;
 * - an attempt whose answer never came (`placing` or `unknown`) is looked up among the contract's active
 *   orders and order history, by our client order id when Gemini returns it, otherwise by its exact
 *   market, side, outcome, price and quantity near the time it was sent. Until exactly one order matches,
 *   the intent is held: the order is never sent again blindly;
 * - only an attempt Gemini refused for a reason that is not the order's (the key, the terms, the account,
 *   the rate limit) is sent again, under the same client order id.
 *
 * The order respects the intent exactly: its market, side, outcome and limit price, and the most whole
 * hundredths of a contract the approved amount buys at that price, on the contract's own grid. It rests as
 * a good-til-cancel limit order until `orderTtlMs` after it was sent or a minute before the market stops
 * trading, whichever comes first; then the venue cancels what is left and records what filled.
 *
 * Settlement: the public event outcome comes first (no private call while a market trades or waits). Once
 * it is published, the account's settled position on that contract and outcome must agree with it on the
 * side that won, hold at least what our order filled, and pay what that quantity pays. Any disagreement is
 * `disputed`, written to the order's record for the console, and never settled while it lasts.
 */
import {
  affordableHundredths,
  estimatedFeeCents,
  findInstrument,
  MIN_ORDER_COST_CENTS,
  toHundredths,
  scaleDecimal,
  type GeminiClient,
  type MarketContract,
} from "@mandate/gemini";
import {
  isGeminiPrivateError,
  type GeminiPrivateClient,
  type GeminiPrivateError,
  type PrivateOrder,
  type SettledPosition,
} from "@mandate/gemini/private";
import {
  ClientOrderIdError,
  clientOrderIdFor,
  formatCents,
  isFinalVenueOrderState,
  payoutFor,
  type PolicyClient,
  type VenueOrderRecord,
  type VenueOrderState,
} from "@mandate/shared";
import type { OrderJournal } from "./order-journal";
import {
  notTrading,
  simulatedVenue,
  type FillState,
  type HeldPosition,
  type Placement,
  type PlacedOrder,
  type PositionOutcome,
  type Venue,
  type VenueOrder,
} from "./venue";

export interface GeminiVenueOptions {
  /** Gemini's public market data for the same environment as `trading` (the sandbox lists other strikes). */
  publicClient: Pick<GeminiClient, "getEvent">;
  /**
   * Gemini production's public market data. A position this venue has no order for was filled by the
   * simulated venue before the executor traded on Gemini, which lists and resolves its markets on
   * production: it is settled there, never on `publicClient`, where the sandbox may not list it.
   */
  productionClient: Pick<GeminiClient, "getEvent">;
  /** The signed client; its environment is the venue's. */
  trading: GeminiPrivateClient;
  journal: OrderJournal;
  /**
   * The contract the orders are for, and the hash of the block it was deployed in: both are part of every
   * client order id, so a later deployment at the same address never reuses one (issue #117).
   */
  deployment: { chainId: number; policy: `0x${string}`; deployBlockHash: `0x${string}` };
  /** How long an order rests unfilled before the rest is cancelled. Default 10 minutes. */
  orderTtlMs?: number;
  /**
   * Whether an unanswered attempt may be matched to an order by its exact terms when Gemini returns no
   * client order ids. Default true. False when the account serves several contracts (#95): another
   * mandate's order for the same terms would be taken for this one, so the intent is held instead.
   */
  matchByTerms?: boolean;
  now?: () => number;
}

/** What `GeminiVenueOptions.deployment` holds. */
export type VenueDeployment = GeminiVenueOptions["deployment"];

/**
 * The deployment as the client order ids name it: the chain, the contract (lower case) and the hash of the
 * block it was deployed in, read from the chain.
 */
export async function venueDeployment(
  client: Pick<PolicyClient, "address" | "publicClient">,
  deployBlock: bigint,
): Promise<VenueDeployment> {
  const block = await client.publicClient.getBlock({ blockNumber: deployBlock });
  return {
    chainId: client.publicClient.chain.id,
    policy: client.address.toLowerCase() as `0x${string}`,
    deployBlockHash: block.hash,
  };
}

/** Orders sent this long before an attempt's recorded time still match it (clock skew between hosts). */
const MATCH_SKEW_MS = 2 * 60_000;
/** Cancel this long before the market stops trading, so the cancel lands before Gemini closes it. */
const CLOSE_MARGIN_MS = 60_000;
export const DEFAULT_ORDER_TTL_MS = 10 * 60_000;

/** "0.42" for 42 cents. */
function priceText(cents: number): string {
  return `0.${String(cents).padStart(2, "0")}`;
}

/** "12.34" for 1234 hundredths. */
function quantityText(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const rest = hundredths % 100;
  return rest === 0 ? String(whole) : `${String(whole)}.${String(rest).padStart(2, "0")}`;
}

/** A grid step in hundredths (quantity) or cents (price), or null when Gemini's value does not fit one. */
function step(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  const scaled = scaleDecimal(value, 2, "exact");
  return scaled === null || scaled <= 0n ? null : Number(scaled);
}

/**
 * The fills' average price in ten-thousandths of a dollar, from Gemini's `avgExecutionPrice` (exact on its
 * cent grid), or the limit when it sent none or one that is not a price between 0 and $1.
 */
function averageTenThousandths(averagePrice: string | null | undefined, limitPrice: number): number {
  const average = averagePrice ? scaleDecimal(averagePrice, 4, "up") : null;
  if (average === null || average <= 0n || average >= 10_000n) return limitPrice * 100;
  return Number(average);
}

/** What fills cost, in cents rounded up: hundredths times the average price. */
function costCents(filledHundredths: number, average: number): number {
  const units = BigInt(filledHundredths) * BigInt(average);
  return Number((units + 9_999n) / 10_000n);
}

/**
 * The fee a record's fills paid, estimated: the one the journal recorded at the fill, or for a record
 * written before the executor estimated fees, the estimate at the average its cost implies (never above
 * the limit). Undefined when nothing filled.
 */
export function journalFeeCents(record: VenueOrderRecord): number | undefined {
  if (record.feeCents !== undefined) return record.feeCents;
  if (record.filledHundredths === 0) return undefined;
  const implied = Math.ceil((record.filledCents * 10_000) / record.filledHundredths);
  return estimatedFeeCents(record.filledHundredths, Math.min(Math.max(implied, 1), record.limitPrice * 100));
}

type Lookup = { found: PrivateOrder } | { found: null; detail: string };

export function geminiVenue(options: GeminiVenueOptions): Venue {
  const { publicClient, productionClient, trading, journal, deployment } = options;
  const now = options.now ?? Date.now;
  const orderTtlMs = options.orderTtlMs ?? DEFAULT_ORDER_TTL_MS;
  const policy = deployment.policy.toLowerCase() as `0x${string}`;
  const where = trading.environment === "sandbox" ? "Gemini's sandbox" : "Gemini (live)";
  /** The latest version of each record this process wrote or read, by intent. */
  const records = new Map<number, VenueOrderRecord>();
  /** A version not stored in the journal yet (the console was down after Gemini answered). */
  const unsaved = new Set<number>();
  /**
   * The revision of a "placing" version whose write failed before anything was sent, by intent. If that
   * write landed after all, the journal shows an attempt this process knows never reached Gemini.
   */
  const neverSent = new Map<number, number>();
  /** When to cancel what is left of each open order, and whether that was asked already. */
  const deadlines = new Map<number, { at: number; cancelAsked: boolean }>();
  const publicOutcomes = simulatedVenue(publicClient, { now });
  const productionOutcomes = simulatedVenue(productionClient, { now });

  const iso = () => new Date(now()).toISOString();

  async function save(next: VenueOrderRecord): Promise<void> {
    records.set(next.intentId, next);
    try {
      await journal.put(next);
      unsaved.delete(next.intentId);
    } catch (error) {
      unsaved.add(next.intentId);
      throw error;
    }
  }

  /** Saves a new version; a failed write is kept and retried on the next change or read. */
  async function update(
    record: VenueOrderRecord,
    change: Partial<VenueOrderRecord>,
  ): Promise<VenueOrderRecord> {
    const next: VenueOrderRecord = { ...record, ...change, revision: record.revision + 1, updatedAt: iso() };
    await save(next).catch(() => undefined);
    return next;
  }

  async function flushUnsaved(intentId: number): Promise<void> {
    const record = records.get(intentId);
    if (record && unsaved.has(intentId)) await save(record).catch(() => undefined);
  }

  /** The record as the journal holds it, unless this process holds a newer one. */
  async function current(intentId: number): Promise<VenueOrderRecord | null> {
    const stored = await journal.get(intentId);
    const local = records.get(intentId);
    if (local && (!stored || local.revision > stored.revision)) return local;
    if (stored) records.set(intentId, stored);
    return stored;
  }

  function stateOf(order: PrivateOrder, filledHundredths: number): VenueOrderState {
    const status = order.status.toLowerCase();
    if (status === "open") return "open";
    if (status === "filled") return "filled";
    return filledHundredths > 0 ? "partly_filled" : "cancelled";
  }

  function closedDetail(state: VenueOrderState, record: VenueOrderRecord): string {
    switch (state) {
      case "filled":
        return `filled on ${where}`;
      case "partly_filled":
        return `${quantityText(record.filledHundredths)} of ${quantityText(record.quantityHundredths)} contracts filled on ${where}, the rest cancelled`;
      default:
        return `cancelled on ${where} with nothing filled`;
    }
  }

  /** The record as Gemini's answer describes the order now. */
  function withOrder(record: VenueOrderRecord, order: PrivateOrder): Partial<VenueOrderRecord> {
    const filledHundredths = Math.min(
      toHundredths(order.filledQuantity ?? "0") ?? 0,
      record.quantityHundredths,
    );
    const state = stateOf(order, filledHundredths);
    const average = averageTenThousandths(order.avgExecutionPrice, record.limitPrice);
    const change: Partial<VenueOrderRecord> = {
      venueOrderId: order.orderId,
      state,
      filledHundredths,
      filledCents: costCents(filledHundredths, average),
    };
    // No answer reports Gemini's fee, so the journal keeps the estimate from its schedule (taker rate).
    if (filledHundredths > 0) change.feeCents = estimatedFeeCents(filledHundredths, average);
    change.detail = isFinalVenueOrderState(state)
      ? closedDetail(state, { ...record, filledHundredths })
      : filledHundredths > 0
        ? `${quantityText(filledHundredths)} of ${quantityText(record.quantityHundredths)} contracts filled so far`
        : `resting on ${where} at ${String(record.limitPrice)}c`;
    return change;
  }

  /**
   * Finds the order an unanswered attempt may have placed. By client order id when Gemini returns ids;
   * otherwise by exact terms near the attempt's time, and only when exactly one order matches.
   */
  async function lookUp(record: VenueOrderRecord): Promise<Lookup> {
    const [active, history] = await Promise.all([
      trading.activeOrders(record.market),
      trading.orderHistory(record.market),
    ]);
    const orders = [...active, ...history];
    const byId = orders.filter((order) => order.clientOrderId === record.clientOrderId);
    if (byId.length === 1 && byId[0]) return { found: byId[0] };
    if (byId.length > 1) {
      return {
        found: null,
        detail: `${String(byId.length)} orders on Gemini carry client order id ${record.clientOrderId}`,
      };
    }
    if (orders.some((order) => order.clientOrderId)) {
      // Gemini keeps client order ids, and none is ours: the attempt never reached it.
      return { found: null, detail: "no order on Gemini carries this intent's client order id" };
    }
    if (options.matchByTerms === false) {
      return {
        found: null,
        detail:
          "Gemini returned no client order ids, and this account places orders for several mandates, so an " +
          "order cannot be told apart by its terms; check Gemini",
      };
    }
    const sentAt = Date.parse(record.placedAt);
    const quantity = quantityText(record.quantityHundredths);
    const matches = orders.filter((order) => {
      const created = order.createdAt ? Date.parse(order.createdAt) : Number.NaN;
      return (
        order.side.toLowerCase() === record.side &&
        order.outcome.toLowerCase() === record.outcome.toLowerCase() &&
        scaleDecimal(order.price, 2, "exact") === BigInt(record.limitPrice) &&
        toHundredths(order.quantity) === record.quantityHundredths &&
        Number.isFinite(created) &&
        created >= sentAt - MATCH_SKEW_MS &&
        created <= now()
      );
    });
    if (matches.length === 1 && matches[0]) return { found: matches[0] };
    return {
      found: null,
      detail:
        matches.length === 0
          ? `no order for ${quantity} contracts at ${String(record.limitPrice)}c on Gemini since the attempt`
          : `${String(matches.length)} orders for ${quantity} contracts at ${String(record.limitPrice)}c match; check Gemini`,
    };
  }

  /** The deadline of an open order: its time to live, or a minute before the market stops trading. */
  async function deadlineOf(record: VenueOrderRecord, contract?: MarketContract | null): Promise<number> {
    const known = deadlines.get(record.intentId);
    if (known) return known.at;
    let found = contract;
    if (found === undefined) {
      found = (
        await findInstrument((ticker) => publicClient.getEvent(ticker), record.market).catch(() => null)
      )?.contract;
    }
    const ttl = Date.parse(record.placedAt) + orderTtlMs;
    const expiry = found?.expiry ? Date.parse(found.expiry) - CLOSE_MARGIN_MS : Number.POSITIVE_INFINITY;
    const at = Math.min(ttl, expiry);
    deadlines.set(record.intentId, { at, cancelAsked: false });
    return at;
  }

  function placed(order: VenueOrder, record: VenueOrderRecord): Placement {
    return { status: "placed", placed: { order, venueOrderId: record.venueOrderId ?? "" } };
  }

  /** Builds and sends a new attempt. */
  async function attempt(order: VenueOrder, previous: VenueOrderRecord | null): Promise<Placement> {
    const found = await findInstrument((ticker) => publicClient.getEvent(ticker), order.market);
    const closed = notTrading(found, order.market, where);
    if (closed !== null || found === null) return { status: "refused", detail: closed ?? "" };
    const { contract } = found;
    const quantityStep = step(contract.quantityIncrement, 1);
    const minimum = step(contract.quantityMinimum, 1);
    const priceStep = step(contract.priceIncrement, 1);
    if (quantityStep === null || minimum === null || priceStep === null) {
      return {
        status: "refused",
        detail: `${where} lists ${order.market} on an order grid this executor cannot use`,
      };
    }
    if (order.limitPrice % priceStep !== 0) {
      return {
        status: "refused",
        detail: `the limit price ${String(order.limitPrice)}c is not on ${order.market}'s ${String(priceStep)}c price grid`,
      };
    }
    // The approved amount covers the order and Gemini's fee: the most contracts whose cost at the limit
    // plus the taker fee there (the worst case) fits it. See @mandate/gemini fees.ts.
    const quantityHundredths = affordableHundredths(order.amountCents, order.limitPrice, quantityStep);
    if (quantityHundredths < minimum || quantityHundredths <= 0) {
      return {
        status: "refused",
        detail: `${formatCents(order.amountCents)} at ${String(order.limitPrice)}c, with Gemini's fee, buys less than the ${quantityText(minimum)} contracts ${where} takes`,
      };
    }
    if (quantityHundredths * order.limitPrice < MIN_ORDER_COST_CENTS * 100) {
      return {
        status: "refused",
        detail: `${quantityText(quantityHundredths)} contracts at ${String(order.limitPrice)}c cost less than the ${formatCents(MIN_ORDER_COST_CENTS)} ${where} takes for an order`,
      };
    }

    // A retry keeps the id its first attempt was sent with, in whichever form it was written: the record
    // does not allow another, and Gemini knows that one. A new id that cannot fit Gemini's limit is refused
    // here, before anything is journalled or sent.
    let clientOrderId: string;
    try {
      clientOrderId = previous?.clientOrderId ?? clientOrderIdFor({ ...deployment, policy }, order.intentId);
    } catch (error) {
      if (!(error instanceof ClientOrderIdError)) throw error;
      return { status: "refused", detail: error.message };
    }

    const sentAt = iso();
    const record: VenueOrderRecord = {
      kind: "venue-order",
      version: 1,
      chainId: deployment.chainId,
      policy,
      intentId: order.intentId,
      revision: (previous?.revision ?? 0) + 1,
      venue: "gemini",
      environment: trading.environment,
      clientOrderId,
      market: order.market,
      side: order.isBuy ? "buy" : "sell",
      outcome: order.outcome,
      quantityHundredths,
      limitPrice: order.limitPrice,
      state: "placing",
      venueOrderId: null,
      filledHundredths: 0,
      filledCents: 0,
      detail: `sending to ${where}`,
      placedAt: sentAt,
      updatedAt: sentAt,
    };
    if (previous && previous.quantityHundredths !== quantityHundredths) {
      return {
        status: "held",
        detail: `the order's size changed since its last attempt (${quantityText(previous.quantityHundredths)} contracts); not sending a different order`,
      };
    }
    // Written first: when the journal cannot take it, nothing is sent (this throws and the executor waits).
    // It is not kept as this process's latest version until the journal took it: an attempt whose first
    // write failed never happened, and must not be mistaken next time for an order that got no answer.
    try {
      await journal.put(record);
    } catch (error) {
      // The write may still have landed (an answer lost on the way back): that version was never sent.
      neverSent.set(order.intentId, record.revision);
      throw error;
    }
    records.set(order.intentId, record);
    unsaved.delete(order.intentId);
    neverSent.delete(order.intentId);

    let answer: PrivateOrder;
    try {
      answer = await trading.placeOrder({
        symbol: order.market,
        side: record.side,
        outcome: order.outcome === "YES" ? "yes" : "no",
        quantity: quantityText(quantityHundredths),
        price: priceText(order.limitPrice),
        clientOrderId: record.clientOrderId,
      });
    } catch (error) {
      if (!isGeminiPrivateError(error)) throw error;
      if (error.outcomeUnknown) {
        await update(record, {
          state: "unknown",
          detail: `no answer from ${where} (${error.kind}); looking the order up, never sending it again`,
        });
        return {
          status: "held",
          detail: `no answer from ${where} when placing it (${error.message}); looking it up`,
        };
      }
      if (error.kind === "rejected" || error.kind === "invalid_argument") {
        const detail = `${where} refused the order: ${error.reason ?? error.kind}${error.message ? ` (${error.message})` : ""}`;
        await update(record, { state: "rejected", detail });
        return { status: "refused", detail };
      }
      const detail = accountProblem(error);
      await update(record, { state: "not_placed", detail });
      return { status: "held", detail };
    }
    const next = await update(record, withOrder(record, answer));
    await deadlineOf(next, contract);
    return placed(order, next);
  }

  /** Why the account cannot trade now, in plain words. */
  function accountProblem(error: GeminiPrivateError): string {
    switch (error.kind) {
      case "terms":
        return `the ${where} account has not accepted the Prediction Markets terms; accept them on Gemini's site (never from code)`;
      case "auth":
        return `${where} refused the API key (${error.reason ?? `HTTP ${String(error.status)}`}); run npm run gemini:doctor`;
      case "account":
        return `${where} does not let this account buy prediction markets (${error.reason ?? "restricted"})`;
      case "nonce":
        return `${where} refused the request's nonce (${error.reason ?? "nonce"}); is another process using this key?`;
      case "rate_limited":
        return `${where} is rate limiting this key`;
      default:
        return `${where} could not take the order (${error.message})`;
    }
  }

  return {
    kind: "gemini",

    async categoryOf(instrumentSymbol) {
      return publicOutcomes.categoryOf(instrumentSymbol);
    },

    async placeOrder(order) {
      await flushUnsaved(order.intentId);
      const record = await current(order.intentId);
      const unsent = record?.state === "placing" && neverSent.get(order.intentId) === record.revision;
      if (record === null || record.state === "not_placed" || unsent) return attempt(order, record);
      switch (record.state) {
        case "rejected":
          return { status: "refused", detail: record.detail ?? `${where} refused the order` };
        case "placing":
        case "unknown": {
          const lookup = await lookUp(record);
          if (lookup.found === null) {
            const detail = `an earlier attempt got no answer and ${lookup.detail}; it is never sent again, so the intent waits`;
            if (record.detail !== detail) await update(record, { state: "unknown", detail });
            return { status: "held", detail };
          }
          const next = await update(record, withOrder(record, lookup.found));
          return placed(order, next);
        }
        default:
          return placed(order, record);
      }
    },

    async readFill(placedOrder: PlacedOrder): Promise<FillState> {
      const { intentId } = placedOrder.order;
      await flushUnsaved(intentId);
      const record = records.get(intentId) ?? (await current(intentId));
      if (record === null || record.venueOrderId === null) {
        throw new Error(`no order on record for intent #${String(intentId)}`);
      }
      if (isFinalVenueOrderState(record.state)) {
        return { state: "closed", filledCents: record.filledCents, detail: record.detail ?? record.state };
      }
      const orderId = record.venueOrderId;
      let order = (await trading.activeOrders(record.market)).find(
        (candidate) => candidate.orderId === orderId,
      );
      order ??= (await trading.orderHistory(record.market)).find(
        (candidate) => candidate.orderId === orderId,
      );
      if (order === undefined) {
        // Gemini lists a new order a moment after accepting it; ask again on the next poll.
        return { state: "open", filledCents: record.filledCents };
      }
      const change = withOrder(record, order);
      const next =
        change.state !== record.state || change.filledHundredths !== record.filledHundredths
          ? await update(record, change)
          : record;
      if (!isFinalVenueOrderState(next.state)) {
        const at = await deadlineOf(next);
        const deadline = deadlines.get(intentId);
        if (now() >= at && deadline && !deadline.cancelAsked) {
          deadline.cancelAsked = true;
          await trading.cancelOrder(orderId).catch((error: unknown) => {
            // Already closed (422) or not found: the next read shows what it became.
            if (!isGeminiPrivateError(error) || error.outcomeUnknown) deadline.cancelAsked = false;
          });
        }
        return { state: "open", filledCents: next.filledCents };
      }
      deadlines.delete(intentId);
      return { state: "closed", filledCents: next.filledCents, detail: next.detail ?? next.state };
    },

    async outcomeSource(position: HeldPosition): Promise<string> {
      return (await current(position.intentId)) === null ? "simulated" : trading.environment;
    },

    async positionOutcome(position: HeldPosition): Promise<PositionOutcome> {
      // The journal first: it says which exchange filled the position. It throws when it cannot be read,
      // so a fill on Gemini is never taken for a simulated one.
      const record = await current(position.intentId);
      if (record === null) {
        // Filled before this executor traded on Gemini (the simulated venue), which read production: listed
        // and resolved there, whatever this venue's own exchange lists.
        const outcome = await productionOutcomes.positionOutcome(position);
        return outcome.status === "resolved" ? { ...outcome, venue: "simulated" } : outcome;
      }
      const outcome = await publicOutcomes.positionOutcome(position);
      if (outcome.status !== "resolved") return outcome;
      const side = position.outcome === "YES" ? "yes" : "no";
      const settled = (await trading.settledPositions()).filter(
        (entry) => entry.instrumentSymbol === position.market && entry.outcome.toLowerCase() === side,
      );
      if (settled.length === 0) {
        // Public outcome first, the account's settlement a little later: wait for it, never assume it.
        return { status: "awaiting", expiresAt: outcome.expiresAt };
      }
      const problem = disagreement(settled, outcome.resolution, record);
      if (problem !== null) {
        const detail = `settlement disagreement: ${problem}; not settled until they agree`;
        if (record.detail !== detail) await update(record, { detail });
        return { status: "disputed", detail };
      }
      const feeCents = journalFeeCents(record);
      return {
        ...outcome,
        contractsHundredths: record.filledHundredths,
        payoutCents: payoutFor(position.outcome, outcome.resolution, record.filledHundredths),
        ...(feeCents === undefined ? {} : { feeCents }),
      };
    },
  };
}

/**
 * Why the account's settled positions on one contract and outcome do not fit the public outcome and our
 * order, or null when they do: every entry names the public side as the winner, together they hold at
 * least what our order filled, and each pays $1 a contract on the winning side and nothing otherwise.
 */
export function disagreement(
  settled: SettledPosition[],
  publicResolution: "yes" | "no",
  record: VenueOrderRecord,
): string | null {
  let held = 0;
  for (const entry of settled) {
    const side = (entry.resolutionSide ?? entry.contractMetadata?.resolutionSide ?? "").toLowerCase();
    if (side !== publicResolution) {
      return `the public event says ${publicResolution.toUpperCase()} won ${record.market}, the account's settled position says ${side.toUpperCase() || "nothing"}`;
    }
    const quantity = toHundredths(entry.positionQuantity ?? entry.position?.replace(/^-/, "") ?? null);
    if (quantity === null) return `Gemini's settled position on ${record.market} has no quantity`;
    const payout =
      entry.payout === null || entry.payout === undefined ? null : scaleDecimal(entry.payout, 2, "half-up");
    const won = entry.outcome.toLowerCase() === publicResolution;
    if (payout === null || Number(payout) !== (won ? quantity : 0)) {
      return `Gemini paid ${entry.payout ?? "nothing"} for ${quantityText(quantity)} ${entry.outcome.toUpperCase()} contracts on ${record.market}, which pay ${won ? "$1 each" : "nothing"}`;
    }
    held += quantity;
  }
  if (held < record.filledHundredths) {
    return `Gemini settled ${quantityText(held)} contracts on ${record.market}, our order filled ${quantityText(record.filledHundredths)}`;
  }
  return null;
}
