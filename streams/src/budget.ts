/**
 * Credit arithmetic for the Mandate Policy Stream.
 *
 * Streams bill per block processed, by network and dataset, whatever the filter returns:
 * https://www.quicknode.com/docs/streams/billing and https://www.quicknode.com/docs/streams/filters
 * The multipliers below come from the calculator data on the billing page (current billing tiers).
 */

/** API credits per block for the `logs` dataset on Arc testnet and Arc mainnet. */
export const LOGS_CREDITS_PER_BLOCK = 20;

/** Block time QuickNode's calculator assumes for Arc (500 ms). Measured average on 2026-11-15 was 0.697 s. */
export const ARC_BLOCK_TIME_SECONDS = 0.5;

/** Build plan allowance per month. Overage is billed and must never happen. */
export const BUILD_PLAN_MONTHLY_CREDITS = 80_000_000;

/** A backfill longer than this many blocks needs --allow-backfill (10,000 blocks is 200,000 credits, about 1.4 hours of Arc). */
export const MAX_UNCONFIRMED_BACKFILL_BLOCKS = 10_000;

export function blocksPerDay(blockTimeSeconds: number = ARC_BLOCK_TIME_SECONDS): number {
  return Math.round(86_400 / blockTimeSeconds);
}

export function creditsForBlocks(blocks: number, creditsPerBlock: number = LOGS_CREDITS_PER_BLOCK): number {
  return Math.max(0, blocks) * creditsPerBlock;
}

/** Credits a tip Stream spends per day of being active. */
export function creditsPerDay(
  blockTimeSeconds: number = ARC_BLOCK_TIME_SECONDS,
  creditsPerBlock: number = LOGS_CREDITS_PER_BLOCK,
): number {
  return creditsForBlocks(blocksPerDay(blockTimeSeconds), creditsPerBlock);
}

/** Credits a tip Stream spends while active between two instants. */
export function creditsBetween(
  from: Date,
  to: Date,
  blockTimeSeconds: number = ARC_BLOCK_TIME_SECONDS,
  creditsPerBlock: number = LOGS_CREDITS_PER_BLOCK,
): number {
  const seconds = Math.max(0, (to.getTime() - from.getTime()) / 1000);
  return creditsForBlocks(Math.ceil(seconds / blockTimeSeconds), creditsPerBlock);
}

export interface BackfillEstimate {
  readonly blocks: number;
  readonly credits: number;
  readonly needsConfirmation: boolean;
}

/** Cost of starting a Stream at `startBlock` when the chain tip is `tipBlock`. */
export function estimateBackfill(
  startBlock: number,
  tipBlock: number,
  maxUnconfirmedBlocks: number = MAX_UNCONFIRMED_BACKFILL_BLOCKS,
): BackfillEstimate {
  const blocks = Math.max(0, tipBlock - startBlock + 1);
  return { blocks, credits: creditsForBlocks(blocks), needsConfirmation: blocks > maxUnconfirmedBlocks };
}
