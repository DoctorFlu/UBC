/**
 * Creates the testnet-only x402 buyer and seller keys in the env file (ENV_FILE, or the repository root .env).
 * A key that is already present is kept; nothing is ever overwritten.
 * Private keys go straight to the file (mode 600) and are never printed; only the public addresses are.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { DEFAULT_ENV_FILE } from "@mandate/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const KEYS = [
  { name: "X402_BUYER_PRIVATE_KEY", role: "buyer" },
  { name: "X402_SELLER_PRIVATE_KEY", role: "seller" },
] as const;

const file = process.env.ENV_FILE ?? DEFAULT_ENV_FILE;
const existing = existsSync(file) ? readFileSync(file, "utf8") : "";

function readKey(name: string): Hex | undefined {
  const match = new RegExp(`^${name}=(0x[0-9a-fA-F]{64})\\s*$`, "m").exec(existing);
  return match?.[1] as Hex | undefined;
}

const lines: string[] = [];
for (const { name, role } of KEYS) {
  const present = readKey(name);
  if (present) {
    console.log(`${role}: ${privateKeyToAccount(present).address} (kept existing ${name})`);
    continue;
  }
  if (new RegExp(`^${name}=`, "m").test(existing)) {
    throw new Error(`${name} exists in ${file} but is not a 32-byte hex key; fix it by hand`);
  }
  const key = generatePrivateKey();
  lines.push(`${name}=${key}`);
  console.log(`${role}: ${privateKeyToAccount(key).address} (new ${name})`);
}

if (lines.length > 0) {
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
}
chmodSync(file, 0o600);
console.log(`env file: ${file}`);
