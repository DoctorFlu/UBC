import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { createPublicClient, http, isAddressEqual } from "viem";

import { describeReason } from "@mandate/shared";

import { auditRows } from "../src/features/audit/audit-rows";
import { formatContractsHundredths, formatUsdCents, formatUsdCentsDelta } from "../src/lib/format";

import { AGENT_ADDRESS, OWNER_ADDRESS, routePath, routes, schemes, viewports } from "./routes";
import { suitePaths } from "./support/chain";
import { DEMO_RECEIPT, reportSignalBudget, snapshot } from "./support/console";
import { watchConsole } from "./support/problems";

const ADVANCED_COOKIE = "mandate-advanced";

/** The cells of one CSV line, with RFC 4180 quoting (the audit export has no line breaks in cells). */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quoted && char === '"' && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

for (const scheme of schemes) {
  for (const viewport of viewports) {
    test.describe(`${viewport.name}, ${scheme}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.name === "phone",
      });

      for (const route of routes) {
        test(`${route.name} renders cleanly`, async ({ page, baseURL }) => {
          const problems = watchConsole(page);
          await page.goto(await routePath(route, baseURL ?? ""));
          await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
          // No horizontal scroll at any width.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          // Tables fit their card on a desktop; they scroll sideways only as a last resort.
          if (viewport.name === "desktop") {
            const clipped = await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>("main [role=region]")]
                .filter((region) => region.offsetParent !== null && region.scrollWidth > region.clientWidth)
                .map((region) => region.getAttribute("aria-labelledby") ?? "table"),
            );
            expect(clipped).toEqual([]);
          }
          if (route.console) {
            // The page reports that it hydrated; until it does, the phone menu waits (lib/page-hydration.ts).
            await expect(page.locator("html[data-page-hydrated]")).toBeAttached();
            // The badge renders once for wide screens and once for phones; one of them shows.
            await expect(page.getByTestId("dev-signer-badge").filter({ visible: true })).toHaveCount(1);
          } else {
            await expect(page.getByTestId("owner-address")).toHaveCount(0);
          }
          await page.waitForLoadState("networkidle");
          expect(problems).toEqual([]);
        });
      }

      test("the dev signer shows the connected owner", async ({ page }) => {
        const problems = watchConsole(page);
        await page.goto("/");
        if (viewport.name === "phone") {
          await page.getByRole("button", { name: "Open menu" }).click();
        }
        const owner = page.locator(`[data-testid="owner-address"][data-address="${OWNER_ADDRESS}"]`).filter({
          visible: true,
        });
        await expect(owner).toBeVisible();
        await expect(owner).toContainText("0xf39F…2266");
        expect(problems).toEqual([]);
      });
    });
  }
}

// The smoke suite only reads the seeded demo, so its tests can run in parallel. Owner actions (approve,
// reject, pause) change the chain and live in live.spec.ts, which has a chain of its own.

/** The 404 status itself is logged by Chrome; that is the expected outcome, not a problem. */
const notFoundResponse = /the server responded with a status of 404/;

test.describe("public pages", () => {
  test("an unknown agent address is a 404", async ({ page }) => {
    const problems = watchConsole(page);
    const response = await page.goto("/agent/not-an-address");
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Nothing at this address")).toBeVisible();
    expect(problems.filter((problem) => !notFoundResponse.test(problem))).toEqual([]);
  });

  test("an address that is not the contract's agent is a 404", async ({ page }) => {
    const problems = watchConsole(page);
    const response = await page.goto(`/agent/${OWNER_ADDRESS}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Nothing at this address")).toBeVisible();
    expect(problems.filter((problem) => !notFoundResponse.test(problem))).toEqual([]);
  });
});

test.describe("seeded demo", () => {
  test("the tag beside the logo names the chain the console resolved", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByTestId("network-tag").filter({ visible: true })).toHaveText("Local");
    await expect(page.locator("main").getByText("Local dev chain", { exact: true })).toBeVisible();
  });

  test("the reason the agent linked offchain checks out", async ({ page }) => {
    await page.goto("/activity/0");
    const sealed = page.getByTestId("sealed-reason");
    await expect(page.getByText("Recorded offchain", { exact: true })).toBeVisible();
    await expect(sealed).toContainText("Verified");
    await expect(sealed).toContainText("The $65,000 rung pays first");
    // The order book the agent saw is a table, one row per strike, with the traded rung marked.
    const prices = page.getByTestId("prices-seen");
    // When the agent saw them: on the owner's clock in words, the exact moment in the markup.
    await expect(prices.locator("caption")).toContainText("Prices seen ");
    await expect(prices.locator("caption time")).toHaveAttribute("datetime", /T13:24:30/);
    await expect(prices.locator("tbody tr")).toHaveCount(3);
    const traded = prices.locator("tbody tr[data-traded]");
    await expect(traded).toHaveCount(1);
    await expect(traded).toContainText("$65,000 or above");
    await expect(traded).toContainText("68¢");
  });

  test("a holdings row shows its error only once edited, and nothing moves when it does", async ({
    page,
  }) => {
    await page.goto("/hedge");
    const save = page.getByRole("button", { name: "Sign and save" });
    await expect(save).toBeVisible();
    await page.getByRole("button", { name: "Add an asset" }).click();
    const row = page.getByTestId("holding-row").last();
    const quantity = row.getByRole("textbox", { name: "Quantity" });
    await expect(quantity).toBeVisible();
    await expect(row.getByText(/Quantity: a number/)).toHaveCount(0);
    await expect(quantity).not.toHaveAttribute("aria-invalid", "true");
    const before = await save.boundingBox();

    await quantity.fill("abc");
    await expect(row.getByText("Quantity: a number like 0.05, at most 8 decimals.")).toBeVisible();
    await expect(quantity).toHaveAttribute("aria-invalid", "true");
    expect(await save.boundingBox()).toEqual(before);

    await quantity.fill("0.05");
    await expect(row.getByText(/Quantity: a number/)).toHaveCount(0);
    expect(await save.boundingBox()).toEqual(before);

    // A save attempt shows the errors of rows nobody edited yet, without sending anything.
    await page.getByRole("button", { name: "Add an asset" }).click();
    const blank = page.getByTestId("holding-row").last();
    await expect(blank.getByText("Use the ticker, like BTC.")).toHaveCount(0);
    await save.click();
    await expect(blank.getByText("Use the ticker, like BTC.")).toBeVisible();
  });

  test("the hedge view shows the agent's plan with exactly the planner's numbers", async ({
    page,
    baseURL,
  }) => {
    const stored = (await snapshot(baseURL ?? "")).offchain.plans[0];
    if (!stored) throw new Error("the warm-up posted no plan");
    const { plan } = stored;
    const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

    await page.goto("/hedge");
    const card = page.getByTestId("agent-plan");
    await expect(card).toHaveAttribute("data-plan-id", plan.planId);
    await expect(card).toContainText(stored.requestText);
    await expect(card).toContainText(formatUsdCents(plan.totals.costCents));
    await expect(card).toContainText(formatUsdCents(plan.totals.maxPayoutCents));
    await expect(card).toContainText(formatContractsHundredths(plan.totals.contractsHundredths));
    // The warm-up carried out the first two orders, citing the plan; the executor filled the first.
    await expect(page.getByTestId("plan-execution")).toHaveText(
      `2 of ${plan.orders.length.toString()} orders proposed, 1 filled.`,
    );
    await expect(page.getByTestId("plan-signal")).toContainText("Used");

    // Every point of the planner's payoff table, in the chart's readout and in the table under it.
    const chart = page.getByRole("img", { name: /Payoff at settlement for BTC/ });
    const readout = page.getByTestId("payoff-readout");
    await chart.focus();
    await page.keyboard.press("Home");
    const lowest = plan.payoff[0];
    if (!lowest) throw new Error("the plan has no payoff");
    await expect(readout).toContainText(`If BTC settles at ${usd(lowest.priceCents)}:`);
    await expect(readout).toContainText(`combined ${formatUsdCentsDelta(lowest.netPnlCents)}`);
    await page.getByText("Every settlement price the planner checked").click();
    const rows = page.getByRole("table", { name: /Payoff by settlement price/ }).locator("tbody tr");
    await expect(rows).toHaveCount(plan.payoff.length);
    const cells = await rows.evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll("th, td")].map((cell) => cell.textContent.trim())),
    );
    expect(cells).toEqual(
      [...plan.payoff]
        .reverse()
        .map((point) => [
          usd(point.priceCents),
          formatUsdCentsDelta(point.unhedgedPnlCents),
          formatUsdCentsDelta(point.hedgePnlCents),
          formatUsdCentsDelta(point.netPnlCents),
        ]),
    );

    // The live ladder marks exactly the rungs the plan buys, with their fractional quantities.
    const ladder = page.getByTestId("live-ladder");
    await expect(ladder).toHaveAttribute("data-event", plan.eventTicker);
    const bought = plan.rungs.filter((rung) => rung.quantityHundredths > 0);
    await expect(ladder.getByTestId("bought-rung")).toHaveText(
      bought.map((rung) => `${formatContractsHundredths(rung.quantityHundredths)} NO`),
    );
  });

  test("the payments panel shows the agent's reported purchase, budget and balance", async ({
    page,
    baseURL,
  }) => {
    // Report today's budget again, as the MCP server does after a purchase: the warm-up's report stops
    // counting at midnight UTC, which a suite started just before it would otherwise run into.
    await reportSignalBudget(baseURL ?? "", AGENT_ADDRESS);
    await page.goto("/payments");
    const payment = page.locator(`#payment-${DEMO_RECEIPT}`);
    await expect(payment).toContainText("BTC weekly hedge signal, BTC2611202200");
    await expect(payment).toContainText("0.001 USDC");
    await expect(payment.getByRole("link", { name: "Intent #0", exact: true })).toBeVisible();
    await expect(page.getByRole("meter", { name: "Spent" })).toHaveAttribute(
      "aria-valuetext",
      "0.001 USDC of 0.02 USDC of today's budget",
    );
    await expect(page.getByText("4.999 USDC")).toBeVisible();
    await expect(page.getByTestId("sample-data")).toHaveCount(0);
  });

  test("an intent without a link says no reason was recorded", async ({ page }) => {
    await page.goto("/activity/1");
    await expect(page.getByTestId("sealed-reason")).toContainText("No reason recorded");
  });

  test("the plan's evidence chain links every record from the request to the fill, and verifies", async ({
    page,
    baseURL,
  }) => {
    const current = await snapshot(baseURL ?? "");
    const stored = current.offchain.plans[0];
    if (!stored) throw new Error("the warm-up posted no plan");
    const cited = (current.chain?.intents ?? []).filter((intent) => {
      const sealed = current.chain?.sealed[intent.id];
      return sealed?.status === "verified" && sealed.document.planId === stored.planId;
    });
    expect(cited.map((intent) => intent.status)).toEqual(["executed", "approved"]);

    // Reached from the hedge page.
    await page.goto("/hedge");
    await page.getByRole("link", { name: "Evidence chain" }).click();
    await expect(page).toHaveURL(new RegExp(`/hedge/plans/${stored.planId}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Evidence chain" })).toBeVisible();
    await expect(page.getByTestId("chain-status")).toHaveAttribute("data-status", "verified");
    await expect(page.getByTestId("chain-status")).toContainText(
      "Verified: all 2 intents' sealed reasons hash to the chain and name this plan and its paid signal.",
    );
    // Transactions, receipts and settlement references are Advanced detail; the page says where they are.
    await expect(page.getByTestId("chain-status")).toContainText("Advanced view shows the transaction");
    await expect(page.getByRole("button", { name: "Copy transaction" })).toHaveCount(0);
    await expect(page.getByTestId("evidence-signal")).not.toContainText(
      "9b1f2d1e-5d55-4c4e-8f61-0b2a3c4d5e6f",
    );
    await page.getByRole("switch", { name: "Advanced view" }).click();
    // The local chain has no explorer: hashes are there to copy, and the page says so.
    await expect(page.getByTestId("chain-status")).toContainText("the local chain, which has no explorer");
    await expect(page.getByRole("link", { name: /in the explorer/ })).toHaveCount(0);

    // In order: the request, the signal, the plan, then each intent with its verdict and fill.
    await expect(page.getByTestId("evidence-request")).toContainText(stored.requestText);
    const signal = page.getByTestId("evidence-signal");
    await expect(signal).toContainText("0.001 USDC");
    await expect(signal).toContainText("9b1f2d1e-5d55-4c4e-8f61-0b2a3c4d5e6f");
    await expect(page.getByTestId("evidence-plan")).toContainText(stored.planId);
    const intents = page.getByTestId("evidence-intent");
    await expect(intents).toHaveCount(2);
    await expect(intents.getByTestId("intent-seal")).toHaveText(["Verified", "Verified"]);
    const [filled, open] = cited;
    if (!filled || !open) throw new Error("two intents cite the plan");
    await expect(intents.nth(0)).toContainText(`Filled ${formatUsdCents(filled.filledCents ?? 0)}`);
    await expect(intents.nth(1)).toContainText("No result recorded yet.");
    await expect(intents.nth(0).getByRole("button", { name: "Copy transaction" })).toHaveCount(3);

    // Each link opens its record: the intent, the payment row, and the plan on the hedge page.
    await intents
      .nth(0)
      .getByRole("link", { name: `Intent #${filled.id.toString()}`, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: `Intent #${filled.id.toString()}` }),
    ).toBeVisible();
    // ...and the intent page leads back to the chain of the plan its reason names.
    await page.getByTestId("sealed-reason").getByRole("link", { name: stored.planId }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Evidence chain" })).toBeVisible();
    await signal.getByRole("link", { name: "Payment record" }).click();
    await expect(page).toHaveURL(new RegExp(`/payments#payment-${DEMO_RECEIPT}$`));
    await expect(page.locator(`#payment-${DEMO_RECEIPT}`)).toBeVisible();
    await page.goBack();
    await page.getByTestId("evidence-plan").getByRole("link", { name: "Hedge page" }).click();
    await expect(page).toHaveURL(/\/hedge\?asset=BTC$/);
    await expect(page.getByTestId("agent-plan")).toHaveAttribute("data-plan-id", stored.planId);
  });

  test("a plan the console does not store says so", async ({ page }) => {
    const problems = watchConsole(page);
    // Intent 0's reason names plan_e2e, which the agent never posted.
    await page.goto("/activity/0");
    await page.getByTestId("sealed-reason").getByRole("link", { name: "plan_e2e" }).click();
    await expect(page).toHaveURL(/\/hedge\/plans\/plan_e2e$/);
    await expect(page.getByText("No plan with this id")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("the public scorecard counts exactly what the audit trail shows, and nothing private", async ({
    page,
    context,
    baseURL,
  }) => {
    const current = await snapshot(baseURL ?? "");
    const events = current.chain?.events ?? [];
    const rows = auditRows({ events, intents: current.chain?.intents ?? [] });
    const count = (keep: (row: (typeof rows)[number]) => boolean) => rows.filter(keep).length.toString();

    const response = await page.goto(`/agent/${AGENT_ADDRESS}`);
    expect(response?.ok()).toBe(true);
    const html = await response?.text();
    const expected: Record<string, string> = {
      "count-proposed": String(current.chain?.intents.length ?? 0),
      "count-approved": count((row) => row.event === "IntentApproved" && row.group === "verdict"),
      "count-held": count((row) => row.event === "IntentNeedsApproval"),
      "count-rejected": count((row) => row.event === "IntentRejected" && row.group === "verdict"),
      "count-owner-approved": count((row) => row.label === "Approved by owner"),
      "count-owner-rejected": count((row) => row.label === "Rejected by owner"),
      "count-filled": count((row) => row.label === "Fill recorded"),
      "count-not-filled": count((row) => row.label === "No fill recorded"),
    };
    for (const [testId, value] of Object.entries(expected)) {
      await expect(page.getByTestId(testId)).toHaveAttribute("data-count", value);
    }

    // Blocked by rule: the same numbers as the audit page's own card.
    const scorecardBlocked = await page
      .getByTestId("count-blocked")
      .evaluateAll((items) =>
        items.map((item) => [
          item.querySelector(".mono")?.textContent ?? "",
          item.getAttribute("data-count"),
        ]),
      );
    // The audit page shows the contract's reason codes in Advanced view.
    await context.addCookies([{ name: ADVANCED_COOKIE, value: "on", url: baseURL ?? "" }]);
    await page.goto("/audit");
    const auditBlocked = await page
      .getByTestId("blocked-by-rule")
      .locator("div:not(:last-child)")
      .evaluateAll((items) =>
        items.map((item) => [
          item.querySelector(".mono")?.textContent ?? "",
          item.querySelector("dd")?.textContent ?? "",
        ]),
      );
    expect(scorecardBlocked).toEqual(auditBlocked);
    expect(scorecardBlocked.length).toBeGreaterThan(0);

    // Each number lists the transactions behind it, and every one is a Policy contract event.
    await page.goto(`/agent/${AGENT_ADDRESS}`);
    const approved = page.getByTestId("count-approved");
    await approved.locator("summary").click();
    const listed = await approved
      .locator("li")
      .evaluateAll((items) =>
        items.map((item) => item.querySelector("[title^='0x']")?.getAttribute("title") ?? ""),
      );
    const eventTxs = new Set(events.map((event) => event.transactionHash));
    expect(listed.length).toBeGreaterThan(0);
    for (const tx of listed) expect(eventTxs.has(tx as `0x${string}`)).toBe(true);

    // Public: no wallet, no owner controls, no way into the console, no form, nothing offchain.
    await expect(page.getByTestId("dev-signer-badge")).toHaveCount(0);
    await expect(page.locator("form")).toHaveCount(0);
    const internal = await page
      .locator("a[href]")
      .evaluateAll((links) =>
        links.map((link) => link.getAttribute("href") ?? "").filter((href) => href.startsWith("/")),
      );
    expect(internal).toEqual([]);
    const stored = current.offchain.plans[0];
    for (const secret of [
      "Cold wallet",
      "The $65,000 rung pays first",
      stored?.requestText ?? "",
      stored?.planId ?? "",
      DEMO_RECEIPT,
      "9b1f2d1e-5d55-4c4e-8f61-0b2a3c4d5e6f",
    ]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(html).not.toContain(secret);
    }
  });

  test("the audit trail filters, orders and exports exactly the rows it shows", async ({ page, baseURL }) => {
    const current = await snapshot(baseURL ?? "");
    const events = current.chain?.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    await page.goto("/audit");
    const table = () => page.getByRole("region", { name: /Policy contract events/ });

    // Everything the console ingested, newest first, except the Paused event setPolicy emits without
    // changing the pause state (the exports keep it).
    const unchanged = auditRows({ events, intents: current.chain?.intents ?? [] }).filter(
      (row) => row.unchanged,
    );
    expect(unchanged.map((row) => row.event)).toEqual(["Paused"]);
    await expect(table().locator("tbody tr")).toHaveCount(events.length - unchanged.length);
    const newest = auditRows({ events, intents: current.chain?.intents ?? [] })
      .filter((row) => !row.unchanged)
      .at(-1);
    await expect(table().locator("tbody tr").first()).toContainText(newest?.label ?? "");
    await expect(page.getByText(/Resumed/)).toHaveCount(0);

    // The owner's own decisions: in the seed, intent 2 approved and intent 3 rejected after a hold.
    await page.getByRole("tab", { name: /Owner decisions/ }).click();
    await expect(table().locator("tbody tr")).toHaveCount(2);
    await page.getByRole("combobox", { name: "Order of events" }).click();
    await page.getByRole("option", { name: "Oldest first" }).click();
    const shown = table().locator("tbody tr");
    await expect(shown.nth(0)).toContainText("Approved by owner Intent #2");
    await expect(shown.nth(1)).toContainText("Rejected by owner Intent #3");

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV, 2 rows" }).click();
    const file = await (await download).path();
    const lines = (await readFile(file, "utf8")).trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    const header = csvCells(lines[0] ?? "");
    const records = lines.slice(1).map((line) => {
      const cells = csvCells(line);
      return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
    });
    expect(records.map((record) => record.label)).toEqual(["Approved by owner", "Rejected by owner"]);

    // Every exported row checks out against the chain itself: its transaction is in that block, at
    // that time, and carries a Policy contract log at that index.
    const deployment = JSON.parse(await readFile(suitePaths("smoke").deploymentFile, "utf8")) as {
      rpcUrl: string;
      address: `0x${string}`;
    };
    const client = createPublicClient({ transport: http(deployment.rpcUrl) });
    for (const record of records) {
      const receipt = await client.getTransactionReceipt({ hash: record.tx_hash as `0x${string}` });
      expect(receipt.status).toBe("success");
      expect(Number(receipt.blockNumber)).toBe(Number(record.block));
      const log = receipt.logs.find((candidate) => candidate.logIndex === Number(record.log_index));
      expect(log ? isAddressEqual(log.address, deployment.address) : false).toBe(true);
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      expect(Number(block.timestamp)).toBe(Number(record.block_timestamp));
    }
  });

  test("the audit counts blocked intents by the contract's reason", async ({ page }) => {
    await page.goto("/audit");
    const blocked = page.getByTestId("blocked-by-rule");
    const reasons = ["over max trade size", "category not allowed"];
    // In words by default, and with the contract's own reason code in Advanced view.
    for (const reason of reasons) {
      await expect(blocked.getByText(describeReason(reason).label, { exact: true })).toBeVisible();
      await expect(blocked.getByText(reason, { exact: true })).toHaveCount(0);
    }
    await page.getByRole("switch", { name: "Advanced view" }).click();
    for (const reason of reasons) {
      await expect(blocked.getByText(reason, { exact: true })).toBeVisible();
    }
  });
});
