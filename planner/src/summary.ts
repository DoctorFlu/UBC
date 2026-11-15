/**
 * Plain-language summary an agent can read to its owner: three to five short sentences with
 * exact numbers, generated from the plan alone.
 */
import type { HedgePlan } from "./types";
import { formatContracts, formatPrice, formatUsd } from "./units";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 20, 2026 22:00 UTC". Fixed format so summaries do not depend on the host locale. */
export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const mm = date.getUTCMinutes().toString().padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCDate().toString()}, ${date.getUTCFullYear().toString()} ${hh}:${mm} UTC`;
}

function percent(bps: number): string {
  return `${Math.floor(bps / 100).toString()}%`;
}

export function summarizePlan(plan: HedgePlan): string {
  const { asset, totals } = plan;
  const holding = `${plan.holdingQuantity} ${asset}`;
  const sentences: string[] = [];

  if (plan.status === "empty") {
    sentences.push(`No hedge is planned for your ${holding}.`);
    const reasons = plan.warnings.filter((w) => w.code !== "ceiling_above_spot").slice(0, 2);
    for (const warning of reasons) sentences.push(warning.message);
    if (reasons.length === 0) sentences.push("Nothing on the ladder fits the goal and limits given.");
    sentences.push(`Spot is ${formatPrice(plan.spotCents)}.`);
    return sentences.join(" ");
  }

  const strikes = plan.rungs.map((r) => r.strikeCents);
  const highest = Math.max(...strikes);
  const lowest = Math.min(...strikes);
  const span =
    plan.rungs.length === 1
      ? `at ${formatPrice(highest)}`
      : `across ${plan.rungs.length.toString()} strikes from ${formatPrice(highest)} down to ${formatPrice(lowest)}`;
  sentences.push(
    `To protect your ${holding} (spot ${formatPrice(plan.spotCents)}), buy ${formatContracts(totals.contractsHundredths)} NO contracts ${span} for ${formatUsd(totals.costCents)}, settling ${formatExpiry(plan.expiry)}.`,
  );

  if (plan.floorCents !== null) {
    const coverage =
      totals.lossAtFloorCents === null || totals.coverageAtFloorBps === null
        ? ""
        : ` against a ${formatUsd(totals.lossAtFloorCents)} loss on the holding there (${percent(totals.coverageAtFloorBps)} covered)`;
    sentences.push(
      `If ${asset} finishes below ${formatPrice(plan.floorCents)}, the hedge pays ${formatUsd(totals.payoutBelowFloorCents)}${coverage}.`,
    );
  }

  const paysBack = plan.breakEven.paysForItselfBelowCents;
  sentences.push(
    paysBack === null
      ? `At or above ${formatPrice(highest)} the hedge expires worthless and its cost is the price of the protection.`
      : `The hedge pays back its cost if ${asset} finishes below ${formatPrice(paysBack)}; at or above ${formatPrice(highest)} it expires worthless.`,
  );

  const limiting = plan.warnings.filter((w) => w.code !== "orders_split");
  const first = limiting[0];
  if (first !== undefined) sentences.push(first.message);
  if (plan.warnings.some((w) => w.code === "orders_split")) {
    sentences.push(`That is ${plan.orders.length.toString()} orders, each within the per-trade limit.`);
  }
  return sentences.slice(0, 5).join(" ");
}
