/**
 * Signing in from the end-to-end tests the way a person does (docs/accounts.md): the operator's admin
 * command prints a claim code, and a browser with a virtual authenticator (Chrome's WebAuthn emulation,
 * no real device) claims the first workspace on /claim and saves the session.
 *
 * Each console the suites start gets one owner session, saved as a Playwright storage state under
 * `.data/e2e-sessions/<port>.json`: pages open it with `test.use({ storageState })`, and the API helpers
 * in console.ts send its cookie. Test-only: the consoles are local and short-lived.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

import { type Browser, type BrowserContext, type Page, chromium, expect } from "@playwright/test";

import { DASHBOARD_DIR } from "./chain";

const run = promisify(execFile);
const SESSIONS_DIR = join(DASHBOARD_DIR, ".data", "e2e-sessions");

/** Where the owner's session for the console at `baseURL` is saved. */
export function ownerStatePath(baseURL: string): string {
  return join(SESSIONS_DIR, `${new URL(baseURL).port || "80"}.json`);
}

/** Forgets a saved owner session, so a suite that starts a new console never sends an old cookie. */
export function forgetOwner(baseURL: string): void {
  rmSync(ownerStatePath(baseURL), { force: true });
}

/** The owner's session cookie for `baseURL`, as a `cookie` header value, or null before the claim. */
export function ownerCookie(baseURL: string): string | null {
  let state: { cookies?: { name: string; value: string }[] };
  try {
    state = JSON.parse(readFileSync(ownerStatePath(baseURL), "utf8")) as typeof state;
  } catch {
    return null;
  }
  const session = state.cookies?.find((cookie) => cookie.name.endsWith("mandate_session"));
  return session ? `${session.name}=${session.value}` : null;
}

/**
 * Runs the operator's admin command against a console's data folder, as `npm run console:admin` does,
 * and returns what it printed on stdout (the code, for `claim-code` and `invite`).
 */
export async function adminCommand(dataDir: string, command: "claim-code" | "invite"): Promise<string> {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const { stdout } = await run(
    process.execPath,
    [tsx, "--import", "./scripts/server-only.mjs", "scripts/admin.ts", command],
    { cwd: DASHBOARD_DIR, env: { ...process.env, CONSOLE_DATA_DIR: dataDir } },
  );
  return stdout.trim();
}

/**
 * Gives the page's browser context a platform authenticator that always verifies the user, like a
 * device unlocked with a fingerprint. Its passkeys live as long as the context.
 */
export async function addVirtualPasskey(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** Registers a passkey on one of the account pages and returns the recovery code it shows once. */
export async function registerOnPage(page: Page, action: string): Promise<string> {
  await page.getByRole("button", { name: action }).click();
  const code = page.getByTestId("recovery-code");
  await expect(code).toBeVisible({ timeout: 60_000 });
  const recoveryCode = (await code.textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "I saved it, open the console" }).click();
  await page.waitForURL((url) => !/\/(claim|sign-up|recover)$/.test(url.pathname), { timeout: 60_000 });
  return recoveryCode;
}

/** `claimOwner` in a browser of its own, for suites that start their console outside a test. */
export async function claimOwnerOnce(baseURL: string, dataDir: string): Promise<void> {
  if (ownerCookie(baseURL) !== null) return;
  const browser = await chromium.launch();
  try {
    await claimOwner(browser, baseURL, dataDir);
  } finally {
    await browser.close();
  }
}

/**
 * Claims the first workspace of the console at `baseURL`, whose data folder is `dataDir`, through the
 * claim page in a fresh browser context, and saves the owner's session for the other tests.
 */
export async function claimOwner(
  browser: Browser,
  baseURL: string,
  dataDir: string,
  name = "Owner",
): Promise<{ context: BrowserContext; recoveryCode: string }> {
  const claimCode = await adminCommand(dataDir, "claim-code");
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await addVirtualPasskey(page);
  await page.goto("/claim", { timeout: 180_000 });
  await page.locator("html[data-page-hydrated]").waitFor({ state: "attached", timeout: 180_000 });
  await page.getByLabel("Claim code").fill(claimCode);
  await page.getByLabel("Your name").fill(name);
  const recoveryCode = await registerOnPage(page, "Claim with a passkey");
  mkdirSync(SESSIONS_DIR, { recursive: true });
  await context.storageState({ path: ownerStatePath(baseURL) });
  await page.close();
  return { context, recoveryCode };
}
