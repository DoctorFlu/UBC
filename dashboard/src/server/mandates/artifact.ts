import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type Abi, type Address, type Hex, keccak256, padHex } from "viem";
import { z } from "zod";

import type { ContractKind } from "@/lib/live/types";

/**
 * The compiled Policy contracts a new mandate is deployed from, as `forge build` writes them
 * (`npm run dev:chain` locally; the image's `contracts` stage, copied into the console image). The console
 * serves the owner's wallet the bytecode to deploy, and checks every deployed contract against the same
 * file, so a contract that is not one of these is never followed.
 */

const artifactSchema = z.object({
  abi: z.array(z.unknown()),
  bytecode: z.object({ object: z.string().regex(/^0x[0-9a-f]+$/) }),
  deployedBytecode: z.object({
    object: z.string().regex(/^0x[0-9a-f]+$/),
    immutableReferences: z
      .record(z.string(), z.array(z.object({ start: z.number().int(), length: z.number().int() })))
      .default({}),
  }),
});

export interface PolicyArtifact {
  kind: ContractKind;
  abi: Abi;
  /** Creation code: what a deployment sends. */
  bytecode: Hex;
  /** Runtime code with every immutable left as zeros. */
  runtime: Hex;
  /**
   * Where the runtime code holds immutables. The production contract has none (its `user` is storage,
   * since `setUser` can hand the role on); the devchain reference has one, `user`.
   */
  immutables: { start: number; length: number }[];
}

const RELATIVE: Record<ContractKind, string[]> = {
  production: ["production", "Policy.sol", "Policy.json"],
  reference: ["PolicyReference.sol", "PolicyReference.json"],
};

/** `CONSOLE_POLICY_ARTIFACTS_DIR`, or `devchain/out` beside or above the working directory. */
export function artifactsDir(configured: string | null): string | null {
  if (configured) return resolve(configured);
  for (const candidate of [
    resolve(/* turbopackIgnore: true */ process.cwd(), "devchain", "out"),
    resolve(/* turbopackIgnore: true */ process.cwd(), "..", "devchain", "out"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const cache = new Map<string, PolicyArtifact>();

/** The compiled contract of this kind, or null when it is not there (contracts not built). */
export function loadPolicyArtifact(dir: string | null, kind: ContractKind): PolicyArtifact | null {
  if (dir === null) return null;
  const path = join(dir, ...RELATIVE[kind]);
  const cached = cache.get(path);
  if (cached) return cached;
  let parsed: z.infer<typeof artifactSchema>;
  try {
    parsed = artifactSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
  const artifact: PolicyArtifact = {
    kind,
    abi: parsed.abi as Abi,
    bytecode: parsed.bytecode.object as Hex,
    runtime: parsed.deployedBytecode.object as Hex,
    immutables: Object.values(parsed.deployedBytecode.immutableReferences).flat(),
  };
  cache.set(path, artifact);
  return artifact;
}

/**
 * Whether `code` (read from the chain) is this contract: every byte equal to the compiled runtime code
 * outside the immutables, and each immutable slot, if it has any, holding `user`. Without immutables
 * the code must equal the compiled runtime exactly. A contract compiled from other source or with other
 * settings fails; its roles are read from storage and checked by the caller.
 */
export function isPolicyRuntime(artifact: PolicyArtifact, code: Hex, user: Address): boolean {
  const onchain = Buffer.from(code.slice(2), "hex");
  const compiled = Buffer.from(artifact.runtime.slice(2), "hex");
  if (onchain.length !== compiled.length || compiled.length === 0) return false;
  const slot = Buffer.from(padHex(user.toLowerCase() as Hex, { size: 32 }).slice(2), "hex");
  const masked = Buffer.from(onchain);
  for (const { start, length } of artifact.immutables) {
    if (length !== 32 || start + length > onchain.length) return false;
    if (!onchain.subarray(start, start + length).equals(slot)) return false;
    masked.fill(0, start, start + length);
  }
  return keccak256(masked) === keccak256(compiled);
}
