import { readFile } from "node:fs/promises";

import { type Page, expect, test } from "@playwright/test";
import { createPublicClient, http, isAddressEqual } from "viem";

import { formatContractsHundredths, formatUsdCents, formatUsdCentsDelta } from "../src/lib/format";

import { OWNER_ADDRESS, routes, schemes, viewports } from "./routes";
import { suitePaths } from "./support/chain";
import { snapshot } from "./support/console";

/**
 * Chrome's "preloaded but not used within a few seconds" hint is a timing report, not a defect:
 * it fires when a loaded machine makes `next dev` slow to serve a page. Everything else counts.
 */
const timingHint = /was preloaded using link preload but not used within a few seconds/;

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

/** Collects console errors, warnings (hydration mismatches are warnings) and uncaught errors. */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (timingHint.test(message.text())) return;
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
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
        test(`${route.name} renders cleanly`, async ({ page }) => {
          const problems = watchConsole(page);
          await page.goto(route.path);
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
    await expect(prices.locator("caption")).toContainText("Prices seen at 13:24");
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
    await expect(page.getByTestId("plan-execution")).toHaveText(
      "Not executed: no intent on the chain cites this plan yet.",
    );
    await expect(page.getByTestId("plan-signal")).toContainText("None");

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

  test("an intent without a link says no reason was recorded", async ({ page }) => {
    await page.goto("/activity/1");
    await expect(page.getByTestId("sealed-reason")).toContainText("No reason recorded");
  });

  test("the audit trail filters, orders and exports exactly the rows it shows", async ({ page, baseURL }) => {
    const current = await snapshot(baseURL ?? "");
    const events = current.chain?.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    await page.goto("/audit");
    const table = () => page.getByRole("region", { name: /Policy contract events/ });

    // Everything the console ingested, newest first.
    await expect(table().locator("tbody tr")).toHaveCount(events.length);
    await expect(table().locator("tbody tr").first()).toContainText(events.at(-1)?.type ?? "");

    // The owner's own decisions: in the seed, intent 2 approved and intent 3 rejected after a hold.
    await page.getByRole("tab", { name: /Owner decisions/ }).click();
    await expect(table().locator("tbody tr")).toHaveCount(2);
    await page.getByRole("combobox", { name: "Order of events" }).selectOption("oldest");
    const shown = table().locator("tbody tr");
    await expect(shown.nth(0)).toContainText("Approved by owner Intent #2");
    await expect(shown.nth(1)).toContainText("Rejected by owner Intent #3");

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export 2 rows as CSV" }).click();
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
    const blocked = page.locator("main");
    await expect(blocked.getByText("over max trade size", { exact: true }).first()).toBeVisible();
    await expect(blocked.getByText("category not allowed", { exact: true }).first()).toBeVisible();
  });
});
