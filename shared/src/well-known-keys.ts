import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/**
 * Keys everyone has: the accounts anvil and Hardhat derive from the published mnemonic "test test test
 * test test test test test test test test junk". They are fine on a local chain, where they hold worthless
 * gas, and never anywhere else: on a shared network anyone could sign as the agent or the executor, and
 * bots sweep anything sent to their addresses at once.
 */
export const WELL_KNOWN_MNEMONIC = "test test test test test test test test test test test junk";

/** How many of the mnemonic's accounts are checked: anvil makes 10 by default, Hardhat 20. */
const WELL_KNOWN_ACCOUNTS = 20;

let wellKnown: Set<string> | null = null;

function wellKnownAddresses(): Set<string> {
  wellKnown ??= new Set(
    Array.from({ length: WELL_KNOWN_ACCOUNTS }, (_, addressIndex) =>
      mnemonicToAccount(WELL_KNOWN_MNEMONIC, { addressIndex }).address.toLowerCase(),
    ),
  );
  return wellKnown;
}

/** Whether `address` belongs to one of the published test accounts. */
export function isWellKnownAddress(address: Address | string): boolean {
  return wellKnownAddresses().has(address.toLowerCase());
}

/** Whether `privateKey` is one of the published test keys. False for anything that is not a key. */
export function isWellKnownKey(privateKey: Hex | string): boolean {
  try {
    return isWellKnownAddress(privateKeyToAccount(privateKey as Hex).address);
  } catch {
    return false;
  }
}

/**
 * Why `privateKey` must not sign where it would, in one sentence that names `variable` and the network and
 * never the key; null when it may. A published test key may sign on the local devchain only.
 *
 * Locality is the caller's to say, from where it sends: the devchain runs with Arc testnet's chain id
 * (5042002, so wallets and signatures behave as on Arc), so the chain id cannot tell the two apart. The
 * MCP server calls a loopback RPC local; the executor, a deployment from the devchain's file.
 */
export function wellKnownKeyRefusal(
  variable: string,
  privateKey: Hex | string,
  target: { local: boolean; network: string },
): string | null {
  if (target.local || !isWellKnownKey(privateKey)) return null;
  return (
    `${variable} is one of anvil's published test keys, which anyone can sign with, and it would sign on ` +
    `${target.network}. Generate a key of its own with npm run arc:keygen.`
  );
}
