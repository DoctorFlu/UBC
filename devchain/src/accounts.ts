import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

/**
 * PUBLIC TEST KEYS. These are anvil's default accounts, derived from the well-known mnemonic
 * "test test test test test test test test test test test junk". Everyone has them, so they only ever
 * hold worthless devchain gas. Never use them on Arc testnet or any other shared network.
 */
const ANVIL_TEST_KEYS = {
  user: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // anvil account 0
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // anvil account 1
  executor: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // anvil account 2
  outsider: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // anvil account 3
} as const satisfies Record<string, Hex>;

/** The contract's roles (`user`, `agent`, `executor`) plus an account that holds none of them. */
export type DevRole = keyof typeof ANVIL_TEST_KEYS;

/** The public test key of a devchain role, for a process that reads its key from the environment. */
export function devPrivateKey(role: DevRole): Hex {
  return ANVIL_TEST_KEYS[role];
}

/** Devchain account for a role: the user deploys and sets rules, the agent proposes, the executor records results. */
export function devAccount(role: DevRole): PrivateKeyAccount {
  return privateKeyToAccount(ANVIL_TEST_KEYS[role]);
}
