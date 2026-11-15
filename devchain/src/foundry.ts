import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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

/** Compiles `contracts/` with forge into `out/`. Forge caches, so repeated calls are fast. */
export function buildContracts(): void {
  const result = spawnSync(foundryBinary("forge"), ["build", "--root", DEVCHAIN_DIR], {
    cwd: DEVCHAIN_DIR,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`forge build failed:\n${result.stderr || result.stdout}`);
  }
}
