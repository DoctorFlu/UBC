import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** The repository root `.env`, two levels up from this file (`shared/src`). */
export const DEFAULT_ENV_FILE = resolve(import.meta.dirname, "..", "..", ".env");

/**
 * Loads `ENV_FILE` (or the repository root `.env`) into `process.env` when the file exists.
 * Variables already set in the environment win.
 * Returns the path that was loaded, or undefined when there was no file.
 */
export function loadEnv(): string | undefined {
  const file = process.env.ENV_FILE ?? DEFAULT_ENV_FILE;
  if (!existsSync(file)) return undefined;
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
