import { DAILY, type TwoExchangeOptions, WEEKLY } from "@mandate/gemini/two-exchanges";

import type { HedgeInput } from "../src";

/**
 * Plans whose output main made at 1ca2f48, before slippage could buy depth (`fixtures/main-1ca2f48`). At
 * slippage 0 the planner must still make each of them exactly: the same id, orders, quantities, limits,
 * amounts and warnings.
 */
export interface GoldenCase {
  name: string;
  environment: "production" | "sandbox";
  exchanges: TwoExchangeOptions & { eventTicker?: string };
  input: Omit<HedgeInput, "ladder">;
}

const limits = { maxTradeCents: 2_500, remainingBudgetCents: 50_000, categoryAllowed: true };
/** Spot for the 12:39 reading: every one of the daily's six sandbox strikes lies below it. */
const AT_1239 = { daily1239: "uncapped" as const, spotUsd: 64_500 };

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: "production 12:39, 0.05 BTC",
    environment: "production",
    exchanges: AT_1239,
    input: {
      holding: { asset: "BTC", quantity: "0.05" },
      goal: { floorCents: 6_300_000 },
      maxCostCents: 5_000,
      limits,
    },
  },
  {
    name: "production 12:39, 0.3 BTC",
    environment: "production",
    exchanges: AT_1239,
    input: {
      holding: { asset: "BTC", quantity: "0.3" },
      goal: { floorCents: 6_300_000 },
      maxCostCents: 30_000,
      limits,
    },
  },
  {
    name: "sandbox capped 12:39, 0.3 BTC",
    environment: "sandbox",
    exchanges: { ...AT_1239, daily1239: "capped" },
    input: {
      holding: { asset: "BTC", quantity: "0.3" },
      goal: { floorCents: 6_300_000 },
      maxCostCents: 30_000,
      limits,
    },
  },
  {
    name: "sandbox one level, 0.05 BTC",
    environment: "sandbox",
    exchanges: { sandboxDailyBooks: "mirrored", spotUsd: 64_500 },
    input: {
      holding: { asset: "BTC", quantity: "0.05" },
      goal: { floorCents: 6_300_000 },
      maxCostCents: 5_000,
      limits,
    },
  },
  {
    name: "production recorded daily, 0.05 BTC, 2 % drop",
    environment: "production",
    exchanges: { eventTicker: DAILY },
    input: {
      holding: { asset: "BTC", quantity: "0.05" },
      goal: { dropPercent: 2 },
      maxCostCents: 5_000,
      limits,
    },
  },
  {
    name: "production recorded weekly, 0.05 BTC, tight cap",
    environment: "production",
    exchanges: { eventTicker: WEEKLY },
    input: {
      holding: { asset: "BTC", quantity: "0.05" },
      goal: { dropPercent: 5 },
      maxCostCents: 1_500,
      limits,
    },
  },
];
