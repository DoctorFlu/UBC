/**
 * Environment helpers for Node processes (the agent, scripts).
 *
 * `@mandate/shared` is also imported by browser code (the dashboard's client components), so this file
 * must not import Node built-ins statically: a bundler would have to ship `node:fs` to the browser.
 * It loads them with `process.getBuiltinModule` when a Node process calls it instead.
 */

/** A Node built-in, or null outside Node (a browser bundle). */
function nodeModule<T extends "node:fs" | "node:path" | "node:url">(id: T) {
  if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return null;
  return process.getBuiltinModule(id);
}

/**
 * A path relative to this file. Built with `node:path` rather than `new URL(relative, import.meta.url)`,
 * which bundlers read as an asset to copy into the build (here the `.env` file, which must never be).
 */
function besideThisFile(...segments: string[]): string | null {
  const url = nodeModule("node:url");
  const path = nodeModule("node:path");
  if (!url || !path) return null;
  try {
    return path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), ...segments);
  } catch {
    return null; // bundled code may not have a file URL
  }
}

/** The repository root `.env`, two levels up from this file (`shared/src`). */
export const DEFAULT_ENV_FILE = besideThisFile("..", "..", ".env") ?? ".env";

/**
 * Loads `ENV_FILE` (or the repository root `.env`) into `process.env` when the file exists.
 * Variables already set in the environment win.
 * Returns the path that was loaded, or undefined when there was no file.
 */
export function loadEnv(): string | undefined {
  const file = process.env.ENV_FILE ?? DEFAULT_ENV_FILE;
  if (!nodeModule("node:fs")?.existsSync(file)) return undefined;
  process.loadEnvFile(file);
  return file;
}

/** Returns a non-empty environment variable or throws a message naming it (never its value). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing environment variable ${name}. Set it in .env (see docs/x402.md).`);
  }
  return value.trim();
}
