import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { laptopWidths, routePath, routes, schemes } from "./routes";
import { firstMandatePath } from "./support/console";
import { watchConsole } from "./support/problems";
import { ownerCookie } from "./support/session";

const ADVANCED_COOKIE = "mandate-advanced";

test.describe("Advanced view", () => {
  test("is off by default, and the default view shows the summary", async ({ page, baseURL }) => {
    const problems = watchConsole(page);
    await page.goto(await firstMandatePath(baseURL ?? ""));
    const toggle = page.getByRole("switch", { name: "Advanced view" });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("rules-summary")).toBeVisible();
    await expect(page.getByText("Committed", { exact: true })).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("turns on from the shell, saves a cookie and survives a reload", async ({
    page,
    context,
    baseURL,
  }) => {
    const problems = watchConsole(page);
    await page.goto(await firstMandatePath(baseURL ?? ""));
    await page.getByRole("switch", { name: "Advanced view" }).click();
    await expect(page.getByRole("switch", { name: "Advanced view" })).toBeChecked();
    await expect(page.getByText("Committed", { exact: true })).toBeVisible();
    const cookie = (await context.cookies()).find((entry) => entry.name === ADVANCED_COOKIE);
    expect(cookie?.value).toBe("on");

    await page.reload();
    await expect(page.getByRole("switch", { name: "Advanced view" })).toBeChecked();
    await expect(page.getByText("Committed", { exact: true })).toBeVisible();
    await expect(page.getByTestId("rules-summary")).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("is rendered by the server from the cookie, so nothing flashes", async ({ request, baseURL }) => {
    // An explicit cookie header replaces the stored ones, so it carries the owner's session too.
    const session = ownerCookie(baseURL ?? "") ?? "";
    const on = await (
      await request.get(await firstMandatePath(baseURL ?? ""), {
        headers: { cookie: `${ADVANCED_COOKIE}=on; ${session}` },
      })
    ).text();
    expect(on).toContain("Committed");
    expect(on).not.toContain('data-testid="rules-summary"');

    const off = await (
      await request.get(await firstMandatePath(baseURL ?? ""), { headers: { cookie: session } })
    ).text();
    expect(off).toContain('data-testid="rules-summary"');
    expect(off).not.toContain("Committed");
  });

  test("hydrates without a mismatch in either mode", async ({ page, context, baseURL }) => {
    const problems = watchConsole(page);
    await context.addCookies([{ name: ADVANCED_COOKIE, value: "on", url: baseURL ?? "" }]);
    await page.goto("/approvals");
    await expect(page.getByRole("switch", { name: "Advanced view" })).toBeChecked();
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });

  test("a deep link to Advanced-only content shows it with a note in the default view", async ({
    page,
    baseURL,
  }) => {
    const problems = watchConsole(page);
    await page.goto(`${await firstMandatePath(baseURL ?? "")}#rule-meters`);
    const note = page.getByTestId("advanced-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("part of Advanced view");
    await expect(page.getByText("Committed", { exact: true })).toBeVisible();

    await note.getByRole("button", { name: "Turn on Advanced view" }).click();
    await expect(page.getByRole("switch", { name: "Advanced view" })).toBeChecked();
    await expect(page.getByTestId("advanced-note")).toHaveCount(0);
    await expect(page.getByText("Committed", { exact: true })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("a deep link works the same with Advanced view on, without the note", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: ADVANCED_COOKIE, value: "on", url: baseURL ?? "" }]);
    await page.goto(`${await firstMandatePath(baseURL ?? "")}#rule-meters`);
    await expect(page.getByText("Committed", { exact: true })).toBeVisible();
    await expect(page.getByTestId("advanced-note")).toHaveCount(0);
  });
});

test.describe("times", () => {
  test.use({ timezoneId: "America/Vancouver", locale: "en-US" });

  test("read in the owner's time zone by default, with the exact UTC time kept in the markup", async ({
    page,
  }) => {
    const problems = watchConsole(page);
    await page.goto("/activity");
    const time = page.locator("main tbody time").first();
    // Relative or local ("Just now", "5 min ago", "Today, 3:20 PM"): never the UTC form the server sent.
    await expect(time).not.toContainText("UTC");
    await expect(time).toHaveAttribute("title", /^\d{1,2} \w{3} \d{4}, \d{2}:\d{2}:\d{2} UTC$/);
    await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });

  test("are exact UTC times in Advanced view", async ({ page, context, baseURL }) => {
    const problems = watchConsole(page);
    await context.addCookies([{ name: ADVANCED_COOKIE, value: "on", url: baseURL ?? "" }]);
    await page.goto("/activity");
    await expect(page.locator("main tbody time").first()).toHaveText(/^\d{2}:\d{2}:\d{2} UTC$/);
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
});

test.describe("live connection behind a proxy", () => {
  test("a slow event stream reads Connecting, then Live, with nothing added to the page", async ({
    page,
    baseURL,
  }) => {
    const path = await firstMandatePath(baseURL ?? "");
    const mandateId = path.split("/m/")[1]?.split("/")[0] ?? "";
    // This page's own stream (#95): the events route with this mandate's `?mandate=`, and no other request.
    const isStream = (url: URL | string) => {
      const parsed = new URL(url);
      return parsed.pathname === "/api/console/events" && parsed.searchParams.get("mandate") === mandateId;
    };
    const lamp = page.getByTestId("live-indicator").filter({ visible: true });
    // First the page and its stream unheld: `next dev` compiles both on their first request, so the held
    // stream below measures only the proxy's delay, never a compile that happens to follow the release.
    const firstStream = page.waitForResponse((response) => isStream(response.url()));
    await page.goto(path);
    expect((await firstStream).status()).toBe(200);
    await expect(lamp).toHaveAttribute("data-health", "live");

    // A proxy in front of an idle console can take seconds to answer the first request.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldStreams = 0;
    await page.route(isStream, async (route) => {
      heldStreams += 1;
      await held;
      await route.continue().catch(() => {});
    });
    const released = page.waitForResponse((response) => isStream(response.url()));
    await page.reload();
    await expect(lamp).toHaveAttribute("data-health", "connecting");
    await expect(lamp).toHaveText(/^Connecting/);
    // The lamp reads Connecting because this page's stream is the one held, not for another reason.
    expect(heldStreams).toBeGreaterThan(0);
    release();
    // The stream's headers are what turn the lamp: wait for them, then for the lamp.
    expect((await released).status()).toBe(200);
    await expect(lamp).toHaveAttribute("data-health", "live");
    await expect(lamp).toHaveText(/^Live/);
  });

  test("the event stream comes back after the proxy answered with an HTTP error", async ({
    page,
    baseURL,
  }) => {
    // A browser's EventSource gives up for good on an HTTP error (a 502 while the console wakes up),
    // where it would retry a dropped connection by itself.
    let failures = 2;
    await page.route("**/api/console/events?*", async (route) => {
      if (failures > 0) {
        failures -= 1;
        await route.fulfill({ status: 502, contentType: "text/plain", body: "Bad gateway" });
        return;
      }
      await route.continue().catch(() => {});
    });
    await page.goto(await firstMandatePath(baseURL ?? ""));
    const lamp = page.getByTestId("live-indicator").filter({ visible: true });
    await expect(lamp).toHaveAttribute("data-health", "disconnected");
    await expect(lamp).toHaveText(/^Reconnecting/);
    // Two retries, one and two seconds apart.
    await expect(lamp).toHaveAttribute("data-health", "live", { timeout: 10_000 });
    expect(failures).toBe(0);
  });
});

test.describe("phone menu on a slow device", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a tap on the menu while the page is still hydrating opens it, without a hydration error", async ({
    page,
    baseURL,
  }) => {
    const problems = watchConsole(page);
    // A slow phone: the shell hydrates first and the page's own boundary later, which leaves a window in
    // which the menu button works but the page below it has not hydrated yet.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
    await page.goto(await firstMandatePath(baseURL ?? ""), { waitUntil: "commit" });
    const menu = page.getByRole("button", { name: "Open menu" });
    const drawer = page.getByRole("dialog");
    // Tap as early as the button exists, and again until a tap lands after the shell hydrated. A tap that
    // the shell queued until the page hydrated opens the drawer later, which makes the button inert, so
    // tap only while the drawer is still closed.
    await expect(async () => {
      if (!(await drawer.isVisible())) await menu.tap({ timeout: 2_000 });
      await expect(drawer).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 45_000, intervals: [0] });
    // The drawer opens only once the page has hydrated, so any hydration error is already in `problems`.
    await expect(page.locator("html[data-page-hydrated]")).toBeAttached();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeAttached();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(problems).toEqual([]);
  });
});

test.describe("hedge disclosure", () => {
  test("keeps the payoff and live ladder closed by default, says what is inside, and opens from the keyboard", async ({
    page,
  }) => {
    const problems = watchConsole(page);
    await page.goto("/hedge");
    // What the owner needs first stays open: the plan, what it costs and covers, and its orders.
    await expect(page.getByTestId("agent-plan")).toBeVisible();
    await expect(page.getByTestId("plan-execution")).toBeVisible();

    // A heading whose button says it is collapsed, described by the one-line summary.
    const heading = page.getByRole("heading", { level: 2, name: "Payoff and live ladder" });
    const trigger = heading.getByRole("button", { name: "Payoff and live ladder" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toHaveAccessibleDescription(
      /^Payoff: pays at most \$[\d,.]+ · Live ladder: \d+ strikes, spot \$[\d,.]+$/,
    );
    await expect(page.getByTestId("live-ladder")).toHaveCount(0);
    await expect(page.getByRole("img", { name: /Payoff at settlement/ })).toHaveCount(0);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId("live-ladder")).toBeVisible();
    await expect(page.getByRole("img", { name: /Payoff at settlement/ })).toBeVisible();
    // Open, the summary is gone: the section says it all.
    await expect(trigger).toHaveAccessibleDescription("");

    await page.keyboard.press("Space");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("live-ladder")).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("is open in Advanced view, and follows the switch", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: ADVANCED_COOKIE, value: "on", url: baseURL ?? "" }]);
    await page.goto("/hedge");
    const trigger = page.getByRole("button", { name: "Payoff and live ladder" });
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("live-ladder")).toBeVisible();
    await page.getByRole("switch", { name: "Advanced view" }).click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("live-ladder")).toHaveCount(0);
  });
});

test.describe("layout", () => {
  for (const width of laptopWidths) {
    test(`at ${width.toString()} px, an order reads on one line beside a rejected and a held verdict`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await firstMandatePath(baseURL ?? "", "/activity"));
      // Activity opens on Waiting while something is held: every row, rejected ones too, is under All.
      await page.getByRole("tab", { name: /^All/ }).click();
      const table = page.getByRole("tabpanel").getByRole("table");
      for (const status of ["rejected", "needs_approval"]) {
        await expect(table.locator(`[data-status="${status}"]`).first()).toBeVisible();
      }
      const summaries = table.getByTestId("order-summary");
      expect(await summaries.count()).toBeGreaterThan(0);
      for (const summary of await summaries.all()) {
        // An inline box has one client rect per line it spans.
        const lines = await summary.evaluate(
          (element) => new Set([...element.getClientRects()].map((rect) => Math.round(rect.top))).size,
        );
        expect(lines, await summary.innerText()).toBe(1);
      }
      // And the page never scrolls sideways for it.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    for (const advanced of [false, true]) {
      test(`at ${width.toString()} px, every Activity tab fits its card${advanced ? " in Advanced view" : ""}`, async ({
        page,
        context,
        baseURL,
      }) => {
        if (advanced) await context.addCookies([{ name: ADVANCED_COOKIE, value: "on", url: baseURL ?? "" }]);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(await firstMandatePath(baseURL ?? "", "/activity"));
        const panel = page.getByRole("tabpanel");
        for (const tab of ["All", "Waiting", "Approved", "Executed", "Failed", "Rejected"]) {
          await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
          // The table is a named region, with rows, and never wider than its card.
          const wrap = panel.getByRole("region", { name: `${tab} intents` });
          await expect(wrap.locator("tbody tr").first()).toBeVisible();
          const fit = await wrap.evaluate((element) => element.scrollWidth - element.clientWidth);
          expect(fit, `${tab}: the table is ${fit.toString()} px wider than its card`).toBeLessThanOrEqual(0);
          // In Advanced view the proposal's transaction is under each verdict, not in a column of its own.
          await expect(panel.getByRole("columnheader", { name: "Proposal" })).toHaveCount(0);
          if (advanced) await expect(wrap.getByText(/^0x[0-9a-f]{4}/i).first()).toBeVisible();
          // Only Waiting decides; the tabs with filled intents show what they paid at expiry.
          await expect(panel.getByRole("columnheader", { name: "Decision" })).toHaveCount(
            tab === "Waiting" ? 1 : 0,
          );
          await expect(panel.getByRole("columnheader", { name: "At expiry" })).toHaveCount(
            tab === "All" || tab === "Executed" ? 1 : 0,
          );
        }
        // Waiting's Approve and Reject are both inside the card.
        await page.getByRole("tab", { name: /^Waiting/ }).click();
        const card = await panel.getByRole("region", { name: "Waiting intents" }).boundingBox();
        if (!card) throw new Error("no table");
        for (const name of [/^Approve /, /^Reject /]) {
          const button = await panel.getByRole("button", { name }).first().boundingBox();
          if (!button) throw new Error(`no ${name.source} button`);
          expect(button.x).toBeGreaterThanOrEqual(card.x);
          expect(button.x + button.width).toBeLessThanOrEqual(card.x + card.width);
        }
      });
    }

    test(`at ${width.toString()} px, Home's figures sit in one row or one column, never two and one`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const groups = page.getByRole("main").locator("dl");
      expect(await groups.count()).toBeGreaterThan(1);
      for (const group of await groups.all()) {
        const boxes = await group.evaluate((element) =>
          [...element.children].map((child) => {
            const box = child.getBoundingClientRect();
            return { top: Math.round(box.top), left: Math.round(box.left) };
          }),
        );
        const rows = new Set(boxes.map((box) => box.top)).size;
        const columns = new Set(boxes.map((box) => box.left)).size;
        expect(rows === 1 || columns === 1, JSON.stringify(boxes)).toBe(true);
      }
    });
  }

  test("a held intent in All has one step to its decision: Decide opens Waiting with focus on its Approve", async ({
    page,
    baseURL,
  }) => {
    await page.goto(await firstMandatePath(baseURL ?? "", "/activity"));
    await page.getByRole("tab", { name: /^All/ }).click();
    const panel = page.getByRole("tabpanel");
    const held = panel.locator("tbody tr", { has: page.getByTestId("decide") }).first();
    const name = await held.getByRole("link", { name: /^Intent #\d+$/ }).textContent();
    const id = /\d+/.exec(name ?? "")?.[0] ?? "";
    await held.getByRole("button", { name: `Decide on intent #${id} in Waiting` }).click();
    await expect(page.getByRole("tab", { name: /^Waiting/ })).toHaveAttribute("aria-selected", "true");
    await expect(
      panel.locator(`#waiting-intent-${id}`).getByRole("button", { name: /^Approve / }),
    ).toBeFocused();
  });

  test("on a phone, Activity's tables stack each intent as a record that fits the screen", async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await firstMandatePath(baseURL ?? "", "/activity"));
    const panel = page.getByRole("tabpanel");
    for (const tab of ["All", "Waiting", "Executed", "Rejected"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      const wrap = panel.getByRole("region", { name: `${tab} intents` });
      await expect(wrap.locator("tbody tr").first()).toBeVisible();
      await expect(wrap.locator("thead")).toBeHidden();
      const fit = await wrap.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(fit, tab).toBeLessThanOrEqual(0);
    }
  });

  for (const width of [1440, 1024, 768, 390]) {
    test(`a held approval card on Overview is as tall as its content at ${width.toString()} px`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await firstMandatePath(baseURL ?? ""));
      const card = page.locator('[data-testid^="waiting-intent-"]').first();
      await expect(card).toBeVisible();
      const gap = await card.evaluate((element) => {
        const style = getComputedStyle(element);
        const inner =
          element.getBoundingClientRect().bottom -
          parseFloat(style.paddingBottom) -
          parseFloat(style.borderBottomWidth);
        const content = Math.max(
          ...[...element.children].map((child) => child.getBoundingClientRect().bottom),
        );
        return inner - content;
      });
      // The last line (or the buttons) sits on the card's bottom padding, with no empty band below it.
      expect(gap).toBeLessThan(1);
    });
  }
});

test.describe("keyboard", () => {
  test("the Advanced view switch toggles with Space", async ({ page, baseURL }) => {
    await page.goto(await firstMandatePath(baseURL ?? ""));
    const toggle = page.getByRole("switch", { name: "Advanced view" });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
  });

  test("tabs move with the arrow keys and keep the choice in the address", async ({ page }) => {
    await page.goto("/approvals");
    const waiting = page.getByRole("tab", { name: /Waiting/ });
    const decided = page.getByRole("tab", { name: /Decided/ });
    await expect(waiting).toHaveAttribute("aria-selected", "true");
    await waiting.focus();
    await page.keyboard.press("ArrowRight");
    await expect(decided).toBeFocused();
    await expect(decided).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?show=decided$/);
    await expect(page.getByRole("tabpanel")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("tab", { name: /Decided/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /Decided/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /Waiting/ })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/approvals$/);
  });

  test("a dialog opens from the keyboard, closes with Escape and returns focus", async ({ page }) => {
    await page.goto("/dev/components");
    const trigger = page.getByRole("button", { name: "Open dialog" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Dialog" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("a select opens, moves and picks with the keyboard", async ({ page }) => {
    await page.goto("/audit");
    const order = page.getByRole("combobox", { name: "Order of events" });
    await expect(order).toContainText("Newest first");
    await order.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "Oldest first" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(order).toContainText("Oldest first");
    await expect(order).toBeFocused();
  });

  test("a long request shows three lines, and Show more appears only when the text does not fit", async ({
    page,
    browser,
  }) => {
    const specimen = (label: string) =>
      page.locator(`[data-specimen="${label}"]`).getByTestId("request-text");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/dev/components");
      const short = specimen("short");
      const long = specimen("long");
      await expect(long.getByRole("button", { name: "Show more" })).toBeVisible();
      await expect(short.getByRole("button")).toHaveCount(0);
      // At most three lines until the reader asks for the rest.
      const lineHeight = await long.locator("p").evaluate((p) => parseFloat(getComputedStyle(p).lineHeight));
      const collapsed = (await long.boundingBox())?.height ?? 0;
      expect(collapsed).toBeLessThanOrEqual(lineHeight * 3 + 1);

      // From the keyboard: Enter opens it, focus stays on the toggle, Space closes it again.
      const more = long.getByRole("button", { name: "Show more" });
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await expect(more).toHaveAttribute("aria-controls", (await long.locator("p").getAttribute("id")) ?? "");
      await more.focus();
      await page.keyboard.press("Enter");
      const less = long.getByRole("button", { name: "Show less" });
      await expect(less).toHaveAttribute("aria-expanded", "true");
      await expect(less).toBeFocused();
      expect((await long.boundingBox())?.height ?? 0).toBeGreaterThan(collapsed + lineHeight);
      await page.keyboard.press("Space");
      await expect(long.getByRole("button", { name: "Show more" })).toBeFocused();
      expect((await long.boundingBox())?.height ?? 0).toBeCloseTo(collapsed, 0);

      // One 600-character word wraps inside the card instead of widening the page.
      const unbroken = specimen("unbroken");
      await expect(unbroken.getByRole("button", { name: "Show more" })).toBeVisible();
      await unbroken.getByRole("button", { name: "Show more" }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }

    // Nothing moves when the page hydrates and the toggle appears: the server's page is the same height.
    const plain = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 900 },
    });
    const before = await plain.newPage();
    await before.goto(new URL("/dev/components", page.url()).toString());
    const unhydrated = await before.locator('[data-specimen="long"]').boundingBox();
    await plain.close();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/dev/components");
    await expect(specimen("long").getByRole("button", { name: "Show more" })).toBeVisible();
    const hydrated = await page.locator('[data-specimen="long"]').boundingBox();
    expect(hydrated?.height).toBe(unhydrated?.height);
    expect(hydrated?.y).toBe(unhydrated?.y);
  });

  test("a toast is announced in the notifications region and dismisses from the keyboard", async ({
    page,
  }) => {
    await page.goto("/dev/components");
    await page.getByRole("button", { name: "Success" }).click();
    const region = page.getByRole("region", { name: "Notifications" });
    const item = region.getByText("A success toast");
    await expect(item).toBeVisible();
    const dismiss = region.getByRole("button", { name: "Dismiss notification" });
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expect(item).toBeHidden();
  });
});

for (const scheme of schemes) {
  test.describe(`accessibility, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    const cases = [
      ...routes.map((route) => ({ route, advanced: false })),
      ...routes.filter((route) => route.console).map((route) => ({ route, advanced: true })),
    ];
    for (const { route, advanced } of cases) {
      test(`${route.name}${advanced ? " in Advanced view" : ""} has no axe violations`, async ({
        page,
        context,
        baseURL,
      }) => {
        if (advanced) await context.addCookies([{ name: ADVANCED_COOKIE, value: "on", url: baseURL ?? "" }]);
        await page.goto(await routePath(route, baseURL ?? ""));
        await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
        await page.waitForLoadState("networkidle");
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        const violations = results.violations.map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
        expect(violations).toEqual([]);
      });
    }

    test("hedge has no axe violations while the live ladder is still loading", async ({ page }) => {
      // Hold the quotes back so the loading state is what axe checks, not whatever timing leaves on screen.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/console/hedge/market?*", async (route) => {
        await held;
        await route.continue().catch(() => {});
      });
      await page.goto("/hedge");
      await expect(page.getByRole("heading", { level: 1, name: "Hedge" })).toBeVisible();
      await page.getByRole("button", { name: "Payoff and live ladder" }).click();
      await expect(page.getByTestId("ladder-loading")).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Loading live quotes" })).toBeAttached();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      release();
      const violations = results.violations.map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target.join(" ")),
      }));
      expect(violations).toEqual([]);
    });
  });
}
