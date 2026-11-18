/**
 * `npm run dev:tunnel`: opens a Cloudflare quick tunnel to the local MCP server and prints what to
 * enter in Grok Bot's "Add a custom connector" dialog. It never prints the token.
 * Start the server first with `npm run dev:mcp` in another terminal.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { Resolver, type LookupAddress } from "node:dns";
import { get } from "node:https";
import type { LookupFunction } from "node:net";
import { createInterface } from "node:readline";
import { loadEnvFile, resolveEnvFile } from "../src/env-file";
import { TUNNEL_ATTEMPTS, TUNNEL_RETRY_MS, tunnelUrlIn } from "./tunnel-url";

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

  let stopping = false;
  let child: ChildProcess | null = null;
  const forward = (signal: NodeJS.Signals) => {
    stopping = true;
    if (child === null) process.exit(0);
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  // Never leave a tunnel running if this script dies.
  process.on("exit", () => {
    if (child !== null && child.exitCode === null) child.kill("SIGTERM");
  });

  // A quick tunnel is asked for from Cloudflare's API, which fails now and then. cloudflared then exits
  // before printing a tunnel URL: that is worth asking again, a few times, after a short wait.
  const attempt = (number: number) => {
    const of = number > 1 ? ` (attempt ${String(number)} of ${String(TUNNEL_ATTEMPTS)})` : "";
    process.stdout.write(`Starting a Cloudflare quick tunnel to ${local}${of} ...\n`);
    const current = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", local], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = current;
    let publicUrl: string | null = null;

    current.on("exit", (code, signal) => {
      const how = signal === null ? `with code ${String(code ?? 0)}` : `on ${signal}`;
      if (publicUrl === null && !stopping && number < TUNNEL_ATTEMPTS) {
        process.stdout.write(
          `cloudflared exited ${how} before it gave a tunnel URL. Asking again in ${String(TUNNEL_RETRY_MS / 1000)} s ...\n`,
        );
        setTimeout(() => {
          if (!stopping) attempt(number + 1);
        }, TUNNEL_RETRY_MS);
        return;
      }
      if (publicUrl === null && !stopping) {
        process.stderr.write(
          `cloudflared exited ${how} on each of ${String(TUNNEL_ATTEMPTS)} attempts before it gave a tunnel URL. Check the [cloudflared] lines above, then run npm run dev:tunnel again.\n`,
        );
        process.exit(1);
      }
      process.stdout.write(`cloudflared exited ${how}.\n`);
      process.exit(signal === null ? (code ?? 0) : 0);
    });

    const onLine = (line: string) => {
      if (!stopping && / ERR /.test(line)) process.stderr.write(`[cloudflared] ${line}\n`);
      const found = tunnelUrlIn(line);
      if (found === null || publicUrl !== null) return;
      publicUrl = found;
      process.stdout.write(`Tunnel created at ${found}. Waiting until it is reachable ...\n`);
      void (async () => {
        for (let check = 0; check < HEALTH_ATTEMPTS; check += 1) {
          await sleep(HEALTH_INTERVAL_MS);
          if (current.exitCode !== null) return;
          if (await isPubliclyHealthy(found)) {
            printConnectorValues(found, envFile);
            process.stdout.write(`Checked ${found}/health through the tunnel: ok.\n`);
            return;
          }
        }
        printConnectorValues(found, envFile);
        process.stderr.write(
          `Could not reach ${found}/health through the tunnel yet. Is the MCP server running on port ${String(port)}?\n`,
        );
      })();
    };
    createInterface({ input: current.stdout }).on("line", onLine);
    createInterface({ input: current.stderr }).on("line", onLine);
  };
  attempt(1);
}

void main();
