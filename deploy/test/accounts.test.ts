/**
 * The hosted stack's side of workspaces and passkeys (docs/accounts.md, docs/hosting.md), checked without
 * Docker: which paths Caddy leaves public, that nothing asks for the old owner login, the settings compose
 * passes, and the operator's admin command as the console image ships it (bundled, run with plain node from
 * an empty folder).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const deploy = (...parts: string[]) => readFileSync(join(root, "deploy", ...parts), "utf8");
const routes = deploy("caddy", "app-routes.caddy");
const compose = deploy("compose.yml");

/** The paths of the `@public` matcher in the routes file. */
function publicPaths(): string[] {
  const line = routes.split("\n").find((entry) => entry.startsWith("@public path "));
  return line?.slice("@public path ".length).trim().split(/\s+/) ?? [];
}

/** The console's account pages: the folders of the (auth) route group, each a public page. */
const accountPages = readdirSync(join(root, "dashboard", "src", "app", "(auth)"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `/${entry.name}`);

/** The Next.js proxy's matcher: the paths it sends to /sign-in when there is no session cookie. */
function proxyMatcher(): RegExp {
  const source = readFileSync(join(root, "dashboard", "src", "proxy.ts"), "utf8");
  const pattern = /matcher:\s*\[\s*"([^"]+)"/.exec(source)?.[1];
  if (!pattern) throw new Error("no matcher in proxy.ts");
  return new RegExp(`^${pattern}$`);
}

/** The block of one compose service, up to the next service. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("Caddy's routes", () => {
  it("leave the account pages and the account API public, and nothing else new", () => {
    expect(accountPages.sort()).toEqual(["/claim", "/recover", "/sign-in", "/sign-up"]);
    expect(publicPaths().sort()).toEqual(
      [
        ...accountPages,
        "/api/auth/*",
        "/agent/*",
        "/_next/static/*",
        "/api/health",
        "/favicon.ico",
        "/icon.svg",
        "/apple-icon.png",
      ].sort(),
    );
  });

  it("agree with the console's own proxy about which pages need no session", () => {
    const matcher = proxyMatcher();
    for (const page of accountPages) expect(matcher.test(page), page).toBe(false);
    for (const page of ["/", "/hedge", "/setup", "/hedge/plans/x"])
      expect(matcher.test(page), page).toBe(true);
  });

  it("ask the console for a session on every other path, with no basic auth anywhere", () => {
    for (const file of ["Caddyfile", "Caddyfile.gateway", "caddy/app-routes.caddy", "caddy/demo-rpc.caddy"]) {
      expect(deploy(file)).not.toMatch(/basic_?auth|CONSOLE_PASSWORD_HASH|CONSOLE_USER/);
    }
    expect(routes).toMatch(/forward_auth console:3000 \{\s*uri \/api\/auth\/forward\s*\}/);
    expect(deploy("caddy", "demo-rpc.caddy")).toMatch(
      /forward_auth console:3000 \{\s*uri \/api\/auth\/forward\/rpc\s*\}/,
    );
    // The cross-site refusal comes before the session check and also guards the public account API.
    expect(routes.indexOf('respond @crossSite "Cross-site request refused" 403')).toBeLessThan(
      routes.indexOf("forward_auth"),
    );
    expect(routes.match(/respond @crossSite/g)).toHaveLength(2);
  });

  it("keep the MCP endpoint and the webhook on their own checks, and the agent API internal", () => {
    expect(routes).toMatch(/handle \/mcp \{\s*reverse_proxy mcp:8787\s*\}/);
    expect(routes).toMatch(/handle \/api\/webhooks\/quicknode \{\s*reverse_proxy console:3000\s*\}/);
    expect(routes).toMatch(/handle \/api\/agent\/\* \{\s*respond 404\s*\}/);
  });
});

describe("compose", () => {
  it("passes Caddy no login settings", () => {
    expect(service("caddy")).not.toMatch(/CONSOLE_PASSWORD_HASH|CONSOLE_USER/);
  });

  it("runs the console in production mode with a required master key behind a trusted proxy", () => {
    const console = service("console");
    expect(console).toMatch(/CONSOLE_MODE: production/);
    expect(console).toMatch(/CONSOLE_MASTER_KEY: \$\{CONSOLE_MASTER_KEY:\?/);
    expect(console).toMatch(/CONSOLE_TRUST_PROXY: "true"/);
    expect(console).toMatch(/CONSOLE_URL: \$\{MANDATE_PUBLIC_URL:-https:\/\/\$\{MANDATE_HOST\}\}/);
  });

  it("keys the MCP server's failed-token limit on the client, and starts it after the console", () => {
    const mcp = service("mcp");
    expect(mcp).toMatch(/MCP_TRUST_PROXY: "true"/);
    expect(mcp).toMatch(/depends_on:\s*console:\s*condition: service_healthy/);
  });

  it("gives the master key to the console only", () => {
    for (const name of ["caddy", "mcp", "signals"]) expect(service(name)).not.toContain("CONSOLE_MASTER_KEY");
  });
});

describe("the admin command in the console image", () => {
  let dir: string;
  let bundle: string;

  function admin(...args: string[]) {
    const result = spawnSync(process.execPath, [bundle, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CONSOLE_DATA_DIR: join(dir, "data") },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mandate-admin-"));
    bundle = join(dir, "admin.mjs");
    const built = spawnSync(
      process.execPath,
      [join(root, "dashboard", "scripts", "build-admin.mjs"), bundle],
      {
        encoding: "utf8",
      },
    );
    expect(built.status, built.stderr).toBe(0);
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs with plain node and no node_modules, and prints each code once, to stdout only", () => {
    expect(admin("status").stdout).toContain("first workspace: not claimed");
    const claim = admin("claim-code");
    expect(claim.status).toBe(0);
    const code = claim.stdout.trim();
    expect(code).toMatch(/^[A-Z0-9-]{12,}$/);
    expect(claim.stderr).not.toContain(code);
    expect(claim.stderr).toContain("/claim");
    const invite = admin("invite");
    expect(invite.status).toBe(0);
    expect(invite.stdout.trim()).not.toBe(code);
    expect(admin("status").stdout).toMatch(/open claim codes: 1\nopen invite codes: 1/);
    // Only hashes reach the database.
    const database = readdirSync(join(dir, "data"))
      .filter((file) => file.startsWith("console"))
      .map((file) => readFileSync(join(dir, "data", file)).toString("latin1"))
      .join("");
    expect(database).not.toContain(code);
  });

  it("refuses an unknown command", () => {
    const result = admin("delete-everything");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});
