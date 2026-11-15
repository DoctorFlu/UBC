import { parseGwei } from "viem";

/**
 * Arc testnet silently drops transactions whose `maxFeePerGas` is below 20 gwei, so every write uses at
 * least this much. It is harmless on the devchain, where accounts hold plenty of test gas.
 */
export const ARC_MIN_MAX_FEE_PER_GAS = parseGwei("20");

export interface Eip1559Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Raises `maxFeePerGas` to at least `floor` and keeps the priority fee no higher than the max fee. */
export function applyFeeFloor(estimate: Eip1559Fees, floor: bigint): Eip1559Fees {
  const maxFeePerGas = estimate.maxFeePerGas > floor ? estimate.maxFeePerGas : floor;
  const maxPriorityFeePerGas =
    estimate.maxPriorityFeePerGas < maxFeePerGas ? estimate.maxPriorityFeePerGas : maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}
