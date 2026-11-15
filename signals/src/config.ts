import { ARC_TESTNET } from "@mandate/shared";
import { getAddress, isAddress, isHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface SignalsConfig {
  /** Address that receives payments (the x402 `payTo`). */
  sellerAddress: Address;
  /** CAIP-2 network the seller accepts payments on. */
  network: `${string}:${string}`;
  /** Circle Gateway API base URL used for x402 verify, settle and supported kinds. */
  facilitatorUrl: string;
  port: number;
}

/**
 * Reads the seller configuration from environment variables.
 * The seller address comes from `X402_SELLER_ADDRESS`, or is derived from `X402_SELLER_PRIVATE_KEY`.
 * The server never needs the private key for anything else, and never logs it.
 */
export function readSignalsConfig(env: NodeJS.ProcessEnv = process.env): SignalsConfig {
  return {
    sellerAddress: readSellerAddress(env),
    network: ARC_TESTNET.network,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? ARC_TESTNET.gatewayApiUrl,
    port: readPort(env.SIGNALS_PORT),
  };
}

function readSellerAddress(env: NodeJS.ProcessEnv): Address {
  const explicit = env.X402_SELLER_ADDRESS?.trim();
  if (explicit) {
    if (!isAddress(explicit)) throw new Error("X402_SELLER_ADDRESS is not a valid address");
    return getAddress(explicit);
  }
  const key = env.X402_SELLER_PRIVATE_KEY?.trim();
  if (key) {
    if (!isHex(key) || key.length !== 66) throw new Error("X402_SELLER_PRIVATE_KEY is not a 32-byte hex key");
    return privateKeyToAccount(key).address;
  }
  throw new Error(
    "Set X402_SELLER_ADDRESS or X402_SELLER_PRIVATE_KEY (run `npm run x402:keygen` to create one).",
  );
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 4021;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error("SIGNALS_PORT must be a TCP port");
  return port;
}
