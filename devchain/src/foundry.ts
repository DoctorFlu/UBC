import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The devchain package directory (holds foundry.toml, contracts/, out/ and deployments/). */
export const DEVCHAIN_DIR = fileURLToPath(new URL("..", import.meta.url));

const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "win32",
};
const ARCHES: Partial<Record<string, string>> = { x64: "amd64", arm64: "arm64" };

/**
 * Path of a Foundry binary installed by the `@foundry-rs/<tool>` npm package. The npm package ships the
 * binary in a per-platform optional dependency; spawning it directly (instead of the Node wrapper) means
 * stopping the process really stops the chain.
 */
export function foundryBinary(tool: "anvil" | "forge"): string {
  const platform = PLATFORMS[process.platform];
  const arch = ARCHES[process.arch];
  if (!platform || !arch) {
    throw new Error(`Foundry npm binaries do not support ${process.platform}/${process.arch}`);
  }
  const binary = process.platform === "win32" ? `${tool}.exe` : tool;
  try {
    return require.resolve(`@foundry-rs/${tool}-${platform}-${arch}/bin/${binary}`);
  } catch {
    throw new Error(
      `@foundry-rs/${tool}-${platform}-${arch} is not installed. Run \`npm install\` from the repo root.`,
    );
  }
}

/** The repo's production contracts project (`/contracts`), compiled read only. */
export const CONTRACTS_DIR = fileURLToPath(new URL("../../contracts", import.meta.url));

/** Where the production `Policy.sol` build goes. Kept under devchain so nothing is written in `/contracts`. */
export const PRODUCTION_OUT_DIR = join(DEVCHAIN_DIR, "out", "production");
const PRODUCTION_CACHE_DIR = join(DEVCHAIN_DIR, "cache", "production");

function forge(args: string[], cwd: string): void {
  const result = spawnSync(foundryBinary("forge"), ["build", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`forge build failed:\n${result.stderr || result.stdout}`);
  }
}

/**
 * Compiles both Policy contracts. Forge caches, so repeated calls are fast.
 * - The devchain reference (`devchain/contracts/PolicyReference.sol`) into `devchain/out/`.
 * - The production contract (`contracts/src/Policy.sol`) as is, with its own `foundry.toml`, into
 *   `devchain/out/production/`.
 */
export function buildContracts(): void {
  forge(["--root", DEVCHAIN_DIR], DEVCHAIN_DIR);
  forge(
    [
      join("src", "Policy.sol"),
      "--root",
      CONTRACTS_DIR,
      "--out",
      PRODUCTION_OUT_DIR,
      "--cache-path",
      PRODUCTION_CACHE_DIR,
    ],
    CONTRACTS_DIR,
  );
}
