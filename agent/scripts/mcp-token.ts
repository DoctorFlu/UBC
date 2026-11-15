/**
 * `npm run mcp:token`: generates a new MCP_AUTH_TOKEN and writes it into the .env file
 * (ENV_FILE, default the repo root .env) with mode 600, leaving every other line as it was.
 * It never prints the token.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveEnvFile, writeEnvVar } from "../src/env-file";

/** 256 random bits, base64url: 43 characters. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function rotateToken(file: string): void {
  writeEnvVar(file, "MCP_AUTH_TOKEN", generateToken());
}

function main(): void {
  const file = resolveEnvFile();
  rotateToken(file);
  process.stdout.write(
    [
      `Wrote a new MCP_AUTH_TOKEN to ${file} (mode 600). The token was not printed.`,
      `View it on this machine with: grep '^MCP_AUTH_TOKEN=' '${file}'`,
      "Next: restart the MCP server, then update the Authorization header of the Grok Bot connector",
      "to 'Bearer ' followed by the new token. The old token stops working once the server restarts.",
      "",
    ].join("\n"),
  );
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) main();
