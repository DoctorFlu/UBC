import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, type TestInfo, expect, test } from "@playwright/test";

import { CONSOLE_AGENT_ROUTES, hashAgentToken } from "@mandate/shared";

import type { ConsoleSnapshot } from "../src/lib/live/types";
import { schemes, viewports } from "./routes";
import { E2E_SERVICE_TOKEN, ownerHeaders, snapshot } from "./support/console";
import { watchConsole } from "./support/problems";
import { type VirtualPasskey, addVirtualPasskey, registerOnPage } from "./support/session";

/**
 * Workspaces and passkeys as a person meets them (docs/accounts.md), on the smoke suite's console, whose
 * first workspace the warm-up claimed and seeded with the demo mandate. Bob signs up for a workspace of
 * his own with a virtual passkey, sees nothing of the first one, makes and revokes an agent token, signs
 * out, signs back in, and gets back in on another device with his recovery code.
 *
 * Set E2E_SHOTS_DIR to keep the screenshots it takes of each account screen and the Agents section.
 */

// Signed out: these tests are about getting in.
test.use({ storageState: { cookies: [], origins: [] } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

function shotPath(testInfo: TestInfo, name: string): string {
  const dir = process.env.E2E_SHOTS_DIR;
  return dir ? join(dir, `${name}.png`) : testInfo.outputPath(`${name}.png`);
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: shotPath(testInfo, name), fullPage: true, animations: "disabled" });
}

/** One part of a console page: a full-page capture would draw the sticky bars wherever it scrolled to. */
async function shotOf(locator: Locator, testInfo: TestInfo, name: string) {
  await locator.page().evaluate(() => document.fonts.ready);
  // The sticky top bar would cover the part once it is scrolled into view; the capture leaves it out.
  await locator.screenshot({
    path: shotPath(testInfo, name),
    animations: "disabled",
    style: "header:not(main header), header:not(main header) * { visibility: hidden !important; }",
  });
}

async function hydrated(page: Page) {
  await page.locator("html[data-page-hydrated]").waitFor({ state: "attached" });
}

/** Which agent the console says a token belongs to, asked the way the MCP server asks. */
async function resolveToken(baseURL: string, token: string): Promise<string | null> {
  const response = await fetch(new URL(CONSOLE_AGENT_ROUTES.resolveToken, baseURL), {
    method: "POST",
    headers: { authorization: `Bearer ${E2E_SERVICE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: hashAgentToken(token), legacy: false }),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`resolving a token answered ${response.status.toString()}`);
  return ((await response.json()) as { agentId: string }).agentId;
}

interface AgentsList {
  agents: { id: string; mandate: { id: string }; tokens: { id: string }[] }[];
}

/** The first workspace's agents, as its owner sees them. */
async function ownerAgents(baseURL: string): Promise<AgentsList> {
  const response = await fetch(new URL("/api/console/agents", baseURL), { headers: ownerHeaders(baseURL) });
  if (!response.ok) throw new Error(`the owner's agents answered ${response.status.toString()}`);
  return (await response.json()) as AgentsList;
}

const SCREENS = [
  { path: "/sign-in", heading: "Sign in", name: "sign-in" },
  { path: "/sign-up", heading: "Create a workspace", name: "sign-up" },
  { path: "/recover", heading: "Use a recovery code", name: "recover" },
] as const;

for (const scheme of schemes) {
  for (const viewport of viewports) {
    test.describe(`account screens, ${viewport.name}, ${scheme}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.name === "phone",
      });
      for (const screen of SCREENS) {
        test(`${screen.name} has one action, fits the screen and passes axe`, async ({ page }, testInfo) => {
          const problems = watchConsole(page);
          await page.goto(screen.path);
          await expect(page.getByRole("heading", { level: 1, name: screen.heading })).toBeVisible();
          await hydrated(page);
          // One clear action per screen: the passkey button; everything else is a link.
          await expect(page.getByRole("main").getByRole("button")).toHaveCount(1);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBe(0);
          expect(await axe(page)).toEqual([]);
          await shot(page, testInfo, `${screen.name}-${viewport.width.toString()}-${scheme}`);
          expect(problems).toEqual([]);
        });
      }
    });
  }
}

test("the claim page sends people to sign in once the console is claimed", async ({ page }) => {
  await page.goto("/claim");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("link", { name: "Claim it" })).toHaveCount(0);
});

test("a signed-out visitor is sent to sign in, and back to the page after", async ({ page }) => {
  await page.goto("/activity");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Factivity$/);
  const api = await page.request.get("/api/console/snapshot");
  expect(api.status()).toBe(401);
  expect(api.headers()["www-authenticate"]).toBeUndefined();
});

test.describe("a second workspace", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1440, height: 900 } });

  let page: Page;
  let recoveryCode = "";
  let token = "";
  let agentId = "";
  let passkey: VirtualPasskey;

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    passkey = await addVirtualPasskey(page);
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test("Bob signs up with a passkey and saves his recovery code", async () => {
    await page.goto("/sign-up");
    await hydrated(page);
    await page.getByLabel("Your name").fill("Bob");
    recoveryCode = await registerOnPage(page, "Create a passkey");
    expect(recoveryCode).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });

  test("sees his own empty mandate and nothing of the first workspace", async ({ baseURL }) => {
    // Home lists his one mandate, with no contract yet (#95).
    await expect(page.getByTestId("mandate-row")).toHaveCount(1);
    await expect(page.getByTestId("mandate-row").getByText("No contract yet")).toBeVisible();
    const his = (await (await page.request.get("/api/console/snapshot")).json()) as ConsoleSnapshot;
    expect(his.contract).toBeNull();
    expect(his.chain).toBeNull();
    expect(his.offchain).toMatchObject({ holdings: [], plans: [], changeRequests: [], signalPayments: [] });
    // The owner's, through the owner's own session, has the demo mandate.
    const owner = await snapshot(baseURL ?? "");
    expect(owner.chain?.intents.length).toBeGreaterThan(0);
    expect(owner.offchain.holdings).not.toEqual([]);
    const bobs = (await (await page.request.get("/api/console/agents")).json()) as AgentsList;
    expect(bobs.agents).toHaveLength(1);
    agentId = bobs.agents[0]?.id ?? "";
    // The first workspace's real ids, read with its owner's session.
    const owners = await ownerAgents(baseURL ?? "");
    const ownerAgent = owners.agents[0];
    if (!ownerAgent) throw new Error("the first workspace has no agent");
    expect(agentId).not.toBe(ownerAgent.id);
    // Naming the first workspace's mandate is a 404, the same answer as for one that does not exist,
    // on the snapshot and on the event stream.
    for (const id of [ownerAgent.mandate.id, "mnd_does_not_exist"]) {
      for (const path of ["/api/console/snapshot", "/api/console/events"]) {
        const response = await page.request.get(`${path}?mandate=${encodeURIComponent(id)}`);
        expect(response.status(), `${path} for ${id}`).toBe(404);
      }
      // Its pages: the same not-found page as for a mandate that does not exist.
      for (const view of ["", "/approvals", "/setup"]) {
        const opened = await page.goto(`/m/${encodeURIComponent(id)}${view}`);
        expect(opened?.status(), `/m/${id}${view}`).toBe(404);
        await expect(page.getByRole("heading", { level: 1, name: "Nothing at this address" })).toBeVisible();
      }
    }
    // Making a token for the first workspace's agent is refused, and its tokens stay as they were.
    const forged = await page.request.post(
      `/api/console/agents/${encodeURIComponent(ownerAgent.id)}/tokens`,
      {
        headers: { origin: new URL(baseURL ?? "").origin },
        data: { name: "Not yours" },
      },
    );
    expect(forged.status()).toBe(404);
    expect((await ownerAgents(baseURL ?? "")).agents[0]?.tokens.map((t) => t.id)).toEqual(
      ownerAgent.tokens.map((t) => t.id),
    );
    await page.goto("/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText("No Policy contract yet", { exact: true })).toBeVisible();
  });

  test("makes an agent token in Setup, shown once, that reaches his agent only", async ({
    baseURL,
  }, testInfo) => {
    const problems = watchConsole(page);
    await page.goto("/setup");
    const agents = page.getByRole("region", { name: "Agents" });
    await expect(agents.getByText("No tokens yet. Create one to connect Grok Bot.")).toBeVisible();
    await hydrated(page);
    await agents.getByLabel("New token").fill("Grok Bot");
    // Wait for the console's answer, not a fixed time: the dialog opens once it arrives.
    const made = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && /\/tokens$/.test(new URL(response.url()).pathname),
    );
    // A new token is a credential: his passkey confirms it, in one prompt the button names (#95).
    await agents.getByRole("button", { name: "Create token with passkey" }).click();
    expect((await made).status()).toBe(201);
    const dialog = page.getByRole("dialog", { name: "Copy your token now" });
    await expect(dialog).toBeVisible();
    token = (await dialog.getByTestId("new-token").textContent())?.trim() ?? "";
    expect(token).toMatch(/^mdt_[A-Za-z0-9_-]{43}$/);
    expect(await axe(page)).toEqual([]);
    await shotOf(dialog, testInfo, "agents-token-1440-light");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    // The next token is for another app.
    await expect(agents.getByLabel("New token")).toHaveValue("");
    // Shown once: the list has its name, never the token.
    await expect(agents.getByRole("cell", { name: "Grok Bot" })).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);
    expect(await resolveToken(baseURL ?? "", token)).toBe(agentId);
    expect(await axe(page)).toEqual([]);
    await shotOf(agents, testInfo, "agents-1440-light");

    for (const viewport of viewports.filter((v) => v.name === "phone")) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.reload();
      await expect(agents.getByRole("cell", { name: "Grok Bot" })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      await shotOf(agents, testInfo, `agents-${viewport.width.toString()}-light`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(problems).toEqual([]);
  });

  test("revokes the token, and it stops at once", async ({ baseURL }) => {
    await page.goto("/setup");
    await hydrated(page);
    const agents = page.getByRole("region", { name: "Agents" });
    await agents.getByRole("button", { name: "Revoke" }).click();
    const confirm = page.getByRole("dialog", { name: 'Revoke "Grok Bot"?' });
    const revoked = page.waitForResponse((response) => response.request().method() === "DELETE");
    await confirm.getByRole("button", { name: "Revoke token" }).click();
    expect((await revoked).status()).toBe(200);
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText('Revoked "Grok Bot"');
    await expect(agents.getByText(/^Revoked /)).toBeVisible();
    expect(await resolveToken(baseURL ?? "", token)).toBeNull();
  });

  test("deploys his mandate's contract from Setup, and its pages follow it", async ({
    baseURL,
  }, testInfo) => {
    const problems = watchConsole(page);
    await page.goto("/setup");
    await hydrated(page);
    const card = page.getByTestId("deploy-card");
    await expect(card).toBeVisible();
    await shotOf(
      page.getByRole("region", { name: "Deploy this mandate's contract" }),
      testInfo,
      "deploy-1440-light",
    );
    const deployed = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/deployment"),
    );
    await card.getByRole("button", { name: "Deploy contract" }).click();
    expect((await deployed).status()).toBe(200);
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Contract deployed");
    await expect(card).toHaveCount(0);

    // His own contract now: on his snapshot, his Activity and his Home row, and not the first workspace's.
    const his = (await (await page.request.get("/api/console/snapshot")).json()) as ConsoleSnapshot;
    expect(his.contract?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(his.contract?.address.toLowerCase()).not.toBe(
      (await snapshot(baseURL ?? "")).contract?.address.toLowerCase(),
    );
    await page.goto("/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText("No Policy contract yet", { exact: true })).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByTestId("mandate-row").getByText("No contract yet")).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("a refused passkey prompt leaves his first rules unsigned and the page as it was", async () => {
    const problems = watchConsole(page);
    await page.goto("/rules");
    await hydrated(page);
    await expect(page.getByRole("heading", { name: "Set the first rules" })).toBeVisible();
    await page.getByRole("button", { name: "Review and confirm" }).click();
    const review = page.getByRole("dialog", { name: "Review the first rules" });
    await passkey.setUserVerified(false);
    try {
      await review.getByRole("button", { name: "Confirm rules with passkey" }).click();
      await expect(page.getByText("You closed the passkey prompt, so nothing was changed.")).toBeVisible();
    } finally {
      await passkey.setUserVerified(true);
    }
    // One prompt, refused: the dialog still offers the same confirmation, and nothing reached the chain.
    await expect(review.getByRole("button", { name: "Confirm rules with passkey" })).toBeEnabled();
    const his = (await (await page.request.get("/api/console/snapshot")).json()) as ConsoleSnapshot;
    expect(his.chain?.rules ?? null).toBeNull();
    expect(problems).toEqual([]);
  });

  test("sets his first rules with one passkey prompt, signed by the console with his mandate's owner key", async () => {
    const testInfo = test.info();
    await page.goto("/rules");
    await hydrated(page);
    await page.getByRole("button", { name: "Review and confirm" }).click();
    const review = page.getByRole("dialog", { name: "Review the first rules" });
    await shotOf(review, testInfo, "rules-passkey-1440-light");
    await review.getByRole("button", { name: "Confirm rules with passkey" }).click();
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Rules set");
    await review.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText(/^Version 1, set /)).toBeVisible();
    const his = (await (await page.request.get("/api/console/snapshot")).json()) as ConsoleSnapshot;
    expect(his.chain?.rules).toMatchObject({ budgetCents: 20_000, maxTradeCents: 2_500 });
    // The audit trail names him and the passkey that confirmed it.
    await page.goto("/audit");
    const actions = page.getByRole("region", { name: "Owner actions" });
    await expect(actions.getByRole("row").filter({ hasText: "Set the rules" })).toContainText("Passkey");
  });

  test("creates a second mandate with one passkey prompt, sees its token once, and switches between the two", async ({
    baseURL,
  }, testInfo) => {
    const problems = watchConsole(page);
    await page.goto("/mandates/new");
    await hydrated(page);
    await page.getByLabel("Mandate name").fill("Hedge ETH");
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/api/console/mandates"),
    );
    await page.getByRole("button", { name: "Create and deploy with passkey" }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByText("Hedge ETH is ready")).toBeVisible();
    const newToken = (await page.getByTestId("new-token").first().textContent())?.trim() ?? "";
    expect(newToken.length).toBeGreaterThan(20);
    await shotOf(page.getByRole("main"), testInfo, "new-mandate-ready-1440-light");
    // The token reaches the new mandate's own agent, not his first one.
    const newAgent = await resolveToken(baseURL ?? "", newToken);
    expect(newAgent).not.toBeNull();
    expect(newAgent).not.toBe(agentId);
    // Shown once: a reload of the page does not show it again.
    await page.reload();
    await expect(page.getByText(newToken)).toHaveCount(0);

    // Home: two rows, each its own.
    await page.goto("/");
    await expect(page.getByTestId("mandate-row")).toHaveCount(2);
    await expect(page.getByTestId("mandate-row").filter({ hasText: "Hedge ETH" })).toHaveCount(1);
    for (const width of [1440, 390]) {
      for (const scheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await shot(page, testInfo, `home-two-${width.toString()}-${scheme}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });

    // The switcher lists both, and takes him to the same view of the other mandate.
    await page.goto("/rules");
    await hydrated(page);
    await page.getByTestId("mandate-switcher").filter({ visible: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Hedge ETH" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Mandate", exact: true })).toBeVisible();
    await shot(page, testInfo, "switcher-open-1440-light");
    await menu.getByRole("menuitem", { name: "Hedge ETH" }).click();
    await expect(page).toHaveURL(/\/m\/mnd_[a-z0-9]+\/rules$/);
    await expect(page.getByTestId("mandate-switcher").filter({ visible: true })).toContainText("Hedge ETH");
    // Its rules are the ones its passkey confirmed at creation, on its own contract.
    const hedge = (await (
      await page.request.get(
        `/api/console/snapshot?mandate=${page.url().split("/m/")[1]?.split("/")[0] ?? ""}`,
      )
    ).json()) as ConsoleSnapshot;
    const first = (await (await page.request.get("/api/console/snapshot")).json()) as ConsoleSnapshot;
    expect(hedge.chain?.rules).toMatchObject({ budgetCents: 20_000 });
    expect(hedge.contract?.address.toLowerCase()).not.toBe(first.contract?.address.toLowerCase());
    expect(problems).toEqual([]);
  });

  test("signs out, is kept out, and signs back in with the same passkey", async () => {
    // From a page of its own, hydrated, not whatever the last test left behind.
    await page.goto("/setup");
    await hydrated(page);
    const signedOut = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/sign-out",
    );
    await page.getByRole("button", { name: "Sign out" }).click();
    expect((await signedOut).status()).toBe(200);
    await page.waitForURL(/\/sign-in$/);
    expect((await page.request.get("/api/console/snapshot")).status()).toBe(401);
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsetup$/);
    await hydrated(page);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    // The passkey prompt, its check and the page load: wait for the navigation, not a fixed time.
    await page.waitForURL(/\/setup$/);
    await expect(page.getByRole("region", { name: "Agents" })).toBeVisible();
  });

  test("an open page whose session ends goes to sign in, not to a stream that never comes back", async ({
    baseURL,
  }) => {
    // Signed in, on a live page. The session then ends elsewhere (another tab signs out), and the
    // console ends the page's stream with it.
    await page.goto("/activity");
    await hydrated(page);
    const elsewhere = await page.context().newPage();
    const out = await elsewhere.request.post("/api/auth/sign-out", {
      headers: { origin: new URL(baseURL ?? "").origin },
    });
    expect(out.status()).toBe(200);
    await elsewhere.close();
    // The stream's reconnect gets 401: the page asks the console once, and goes to sign in.
    // Back to the page it was on: his mandate's Activity (#95).
    await page.waitForURL(/\/sign-in\?next=%2Fm%2Fmnd_[a-z0-9]+%2Factivity$/);
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  });

  test("gets back in on another device with the recovery code, which then works no more", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const other = await context.newPage();
      await addVirtualPasskey(other);
      await other.goto("/recover");
      await hydrated(other);
      await other.getByRole("textbox", { name: "Recovery code" }).fill(recoveryCode);
      const next = await registerOnPage(other, "Add a passkey");
      expect(next).not.toBe(recoveryCode);
      await other.goto("/setup");
      await expect(other.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
      await expect(
        other.getByRole("region", { name: "Agents" }).getByRole("cell", { name: "Grok Bot" }),
      ).toBeVisible();

      // The used code is spent.
      const again = await browser.newContext({ baseURL });
      try {
        const third = await again.newPage();
        await addVirtualPasskey(third);
        await third.goto("/recover");
        await hydrated(third);
        await third.getByRole("textbox", { name: "Recovery code" }).fill(recoveryCode);
        await third.getByRole("button", { name: "Add a passkey" }).click();
        await expect(third.getByRole("main").getByRole("alert")).toContainText(
          "That recovery code is not valid.",
        );
      } finally {
        await again.close();
      }
    } finally {
      await context.close();
    }
  });
});
