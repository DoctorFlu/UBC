/**
 * `npm run arc:keygen [-- --replace]`: the agent's and the executor's keys for Arc testnet, written into the
 * env file (ENV_FILE, default the repository root .env) with mode 600. Prints the two addresses and never a
 * key. The owner role is the owner's own browser wallet; this makes no owner key.
 *
 * - An empty or missing `AGENT_PRIVATE_KEY` or `EXECUTOR_PRIVATE_KEY` gets a new key.
 * - A key already there is kept, unless `--replace` is given.
 * - One of anvil's published test keys, a value that is not a key, or the same key for both roles is
 *   refused: run again with `--replace` to put new keys in their place.
 *
 * The addresses then need gas (Arc testnet USDC from https://faucet.circle.com) and their roles
 * (`setAgent`, `setExecutor`, called by the contract's owner); `npm run arc:doctor` says which is missing.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isWellKnownKey } from "@mandate/shared/node";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resolveEnvFile, writeEnvVar } from "../src/env-file";

export const ARC_KEYS = [
  { name: "AGENT_PRIVATE_KEY", role: "agent", setter: "setAgent" },
  { name: "EXECUTOR_PRIVATE_KEY", role: "executor", setter: "setExecutor" },
] as const;

export type ArcKeyName = (typeof ARC_KEYS)[number]["name"];

/** What the env file holds for a key: nothing, a key, or something else (never returned as text). */
type Present = { kind: "absent" } | { kind: "key"; key: Hex } | { kind: "invalid" };

/** The last assignment of `name` in `content`, as `upsertEnvVar` would see it. */
export function presentKey(content: string, name: string): Present {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`, "gm");
  let value: string | undefined;
  for (const match of content.matchAll(pattern)) value = match[1];
  if (value === undefined) return { kind: "absent" };
  const bare = value
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
  if (bare === "") return { kind: "absent" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(bare)) return { kind: "invalid" };
  try {
    privateKeyToAccount(bare as Hex);
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "key", key: bare as Hex };
}

export interface KeygenResult {
  /** One line per role: its address and what happened. Never a key. */
  lines: string[];
  addresses: Record<"agent" | "executor", Address>;
}

/** Refused, with the reason to print; nothing was written. */
export class KeygenRefused extends Error {
  override readonly name = "KeygenRefused";
}

/**
 * Makes sure `file` holds a key of its own for each role, and returns the addresses. Throws
 * `KeygenRefused` before writing anything when a key there may not be kept.
 */
export function ensureArcKeys(file: string, options: { replace: boolean }): KeygenResult {
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = ARC_KEYS.map((spec) => ({ spec, present: presentKey(content, spec.name) }));

  if (!options.replace) {
    const problems: string[] = [];
    for (const { spec, present: value } of present) {
      if (value.kind === "invalid") problems.push(`${spec.name} is set but is not a 32-byte hex private key`);
      if (value.kind === "key" && isWellKnownKey(value.key)) {
        problems.push(`${spec.name} is one of anvil's published test keys, which anyone can sign with`);
      }
    }
    const [agent, executor] = present.map((entry) => entry.present);
    if (
      agent?.kind === "key" &&
      executor?.kind === "key" &&
      agent.key.toLowerCase() === executor.key.toLowerCase()
    ) {
      problems.push("AGENT_PRIVATE_KEY and EXECUTOR_PRIVATE_KEY are the same key; each role needs its own");
    }
    if (problems.length > 0) {
      throw new KeygenRefused(
        `${problems.join(". ")}. Nothing was changed. Run npm run arc:keygen -- --replace to put new keys in their place.`,
      );
    }
  }

  const lines: string[] = [];
  const addresses = {} as Record<"agent" | "executor", Address>;
  for (const { spec, present: value } of present) {
    if (value.kind === "key" && !options.replace) {
      addresses[spec.role] = privateKeyToAccount(value.key).address;
      lines.push(`${spec.role}: ${addresses[spec.role]} (kept the existing ${spec.name})`);
      continue;
    }
    const key = generatePrivateKey();
    writeEnvVar(file, spec.name, key);
    addresses[spec.role] = privateKeyToAccount(key).address;
    const what = value.kind === "absent" ? "new" : "replaced";
    lines.push(`${spec.role}: ${addresses[spec.role]} (${what} ${spec.name})`);
  }
  return { lines, addresses };
}

function main(): void {
  const { values } = parseArgs({ options: { replace: { type: "boolean", default: false } } });
  const file = resolveEnvFile();
  let result: KeygenResult;
  try {
    result = ensureArcKeys(file, { replace: values.replace });
  } catch (error) {
    if (!(error instanceof KeygenRefused)) throw error;
    process.stderr.write(`arc:keygen: ${error.message}\nEnv file: ${file}\n`);
    process.exit(1);
  }
  process.stdout.write(
    [
      "Arc testnet keys (the keys were not printed):",
      ...result.lines.map((line) => `  ${line}`),
      `Env file: ${file} (mode 600)`,
      "",
      "Next:",
      `  1. Fund both addresses with Arc testnet USDC (gas) at https://faucet.circle.com.`,
      `  2. Ask the contract's owner to call setAgent(${result.addresses.agent}) and setExecutor(${result.addresses.executor}).`,
      "  3. Run npm run arc:doctor; it ends with READY or with the next step.",
      "  On the hosted machine, put the same keys in with deploy/set-secret.sh (docs/hosting.md, Arc testnet).",
      "",
    ].join("\n"),
  );
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) main();
