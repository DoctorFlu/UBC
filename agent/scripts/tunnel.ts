/**
 * `npm run dev:tunnel`: opens a Cloudflare quick tunnel to the local MCP server and prints what to
 * enter in Grok Bot's "Add a custom connector" dialog. It never prints the token.
 * Start the server first with `npm run dev:mcp` in another terminal.
 */
import { spawn, spawnSync } from "node:child_process";
import { Resolver, type LookupAddress } from "node:dns";
import { get } from "node:https";
import type { LookupFunction } from "node:net";
import { createInterface } from "node:readline";
import { loadEnvFile, resolveEnvFile } from "../src/env-file";

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const HEALTH_ATTEMPTS = 30;
const HEALTH_INTERVAL_MS = 2000;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function isHealthy(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

// A new trycloudflare.com name takes a few seconds to appear in DNS. Asking the system resolver
// too early makes it cache "no such host" for minutes, which would break the owner's own checks,
// so the probe asks public resolvers directly, with a fresh resolver each time because resolvers
// cache negative answers too.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  const publicResolver = new Resolver({ timeout: 3000, tries: 1 });
  publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);
  publicResolver.resolve4(hostname, (error, addresses: string[] | undefined) => {
    const address = error === null ? addresses?.[0] : undefined;
    if (address === undefined) {
      callback(error ?? new Error(`No address for ${hostname}`), "", 4);
      return;
    }
    if (options.all === true) callback(null, [{ address, family: 4 } satisfies LookupAddress]);
    else callback(null, address, 4);
  });
};

function isPubliclyHealthy(base: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(`${base}/health`, { lookup: publicLookup, timeout: 5000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => {
      resolve(false);
    });
  });
}

function printConnectorValues(publicUrl: string, envFile: string): void {
  process.stdout.write(
    [
      "",
      `Tunnel is up: ${publicUrl}`,
      "",
      'In Grok Bot, open "Connect apps", choose "Add a custom connector", and enter:',
      "  Name:             Mandate",
      "  Type:             Remote HTTPS",
      `  Server URL:       ${publicUrl}/mcp`,
      "  HTTP header name: Authorization",
      '  Header value:     type "Bearer " (with one space), then paste the value of MCP_AUTH_TOKEN',
      "  OAuth Client ID:  leave empty",
      "",
      `View the token on this machine with: grep '^MCP_AUTH_TOKEN=' '${envFile}'`,
      "Paste it only into the connector dialog, never into a chat.",
      "The URL changes every time this tunnel restarts; update the connector's Server URL when it does.",
      "Press Ctrl+C to close the tunnel.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const envFile = resolveEnvFile();
  loadEnvFile(envFile);
  const port = Number(process.env["MCP_PORT"] ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write("MCP_PORT must be a port number.\n");
    process.exit(1);
  }

  const version = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  if (version.error !== undefined) {
    process.stderr.write(
      [
        "cloudflared is not installed or not on PATH.",
        "Install it with: brew install cloudflared",
        "Other platforms: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const local = `http://127.0.0.1:${port}`;
  if (!(await isHealthy(local))) {
    process.stderr.write(
      `Warning: no MCP server answers at ${local}/health. Start it with \`npm run dev:mcp\` in another terminal.\n`,
    );
  }

  process.stdout.write(`Starting a Cloudflare quick tunnel to ${local} ...\n`);
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", local], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stopping = false;
  const forward = (signal: NodeJS.Signals) => {
    stopping = true;
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  // Never leave a tunnel running if this script dies.
  process.on("exit", () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  child.on("exit", (code, signal) => {
    process.stdout.write(
      `cloudflared exited${signal === null ? ` with code ${code ?? 0}` : ` on ${signal}`}.\n`,
    );
    process.exit(signal === null ? (code ?? 0) : 0);
  });

  let announced = false;
  const onLine = (line: string) => {
    if (!stopping && / ERR /.test(line)) process.stderr.write(`[cloudflared] ${line}\n`);
    const match = TUNNEL_URL.exec(line);
    if (match === null || announced) return;
    announced = true;
    const publicUrl = match[0];
    process.stdout.write(`Tunnel created at ${publicUrl}. Waiting until it is reachable ...\n`);
    void (async () => {
      for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
        await sleep(HEALTH_INTERVAL_MS);
        if (await isPubliclyHealthy(publicUrl)) {
          printConnectorValues(publicUrl, envFile);
          process.stdout.write(`Checked ${publicUrl}/health through the tunnel: ok.\n`);
          return;
        }
      }
      printConnectorValues(publicUrl, envFile);
      process.stderr.write(
        `Could not reach ${publicUrl}/health through the tunnel yet. Is the MCP server running on port ${port}?\n`,
      );
    })();
  };
  createInterface({ input: child.stdout }).on("line", onLine);
  createInterface({ input: child.stderr }).on("line", onLine);
}

void main();
