import { KNOWN_ASSETS } from "@mandate/gemini";
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
  hedge: {
    /** Price of one hedge signal in USDC, a decimal string below one cent, for example `"0.001"`. */
    priceUsd: string;
    /** Assets the seller covers, upper case. */
    assets: string[];
    /** Edge in cents, either way, before a strike is called cheap or expensive. */
    fairBandCents: number;
    /** Hourly returns in the realised volatility window. */
    volWindowHours: number;
  };
}

export const DEFAULT_HEDGE_PRICE_USD = "0.001";
export const DEFAULT_FAIR_BAND_CENTS = 2;
export const DEFAULT_VOL_WINDOW_HOURS = 168;

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
    hedge: {
      priceUsd: readSubCentPrice(env.SIGNALS_HEDGE_PRICE_USD),
      assets: readAssets(env.SIGNALS_ASSETS),
      fairBandCents: readInteger(
        env.SIGNALS_FAIR_BAND_CENTS,
        "SIGNALS_FAIR_BAND_CENTS",
        DEFAULT_FAIR_BAND_CENTS,
        1,
        50,
      ),
      volWindowHours: readInteger(
        env.SIGNALS_VOL_WINDOW_HOURS,
        "SIGNALS_VOL_WINDOW_HOURS",
        DEFAULT_VOL_WINDOW_HOURS,
        24,
        1_000,
      ),
    },
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

/**
 * A USDC price as a plain decimal from 0.000001 (Gateway's minimum, one base unit) up to but not
 * including 0.01: the signal is sold for a fraction of a cent.
 */
export function readSubCentPrice(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_HEDGE_PRICE_USD;
  const match = /^0\.(\d{1,6})$/.exec(value);
  const digits = match?.[1]?.padEnd(6, "0");
  const baseUnits = digits === undefined ? 0 : Number(digits);
  if (baseUnits < 1 || baseUnits >= 10_000) {
    throw new Error(
      "SIGNALS_HEDGE_PRICE_USD must be a USDC amount from 0.000001 to 0.009999 (a fraction of a cent), for example 0.001",
    );
  }
  return value;
}

function readAssets(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (value === undefined || value === "") return [...KNOWN_ASSETS];
  const assets = value
    .split(",")
    .map((asset) => asset.trim().toUpperCase())
    .filter((asset) => asset !== "");
  if (assets.length === 0 || assets.some((asset) => !/^[A-Z0-9]{2,10}$/.test(asset))) {
    throw new Error("SIGNALS_ASSETS must be a comma-separated list of asset symbols, for example BTC,ETH");
  }
  return [...new Set(assets)];
}

function readInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return parsed;
}
