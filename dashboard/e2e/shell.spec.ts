import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { routePath, routes, schemes } from "./routes";
import { watchConsole } from "./support/problems";

const ADVANCED_COOKIE = "mandate-advanced";

test.describe("Advanced view", () => {
  test("is off by default, and the default view shows the summary", async ({ page }) => {
    const problems = watchConsole(page);
    await page.goto("/");
    const toggle = page.getByRole("switch", { name: "Advanced view" });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("rules-summary")).toBeVisible();
    await expect(page.getByText("Committed", { exact: true })).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("turns on from the shell, saves a cookie and survives a reload", async ({ page, context }) => {
    const problems = watchConsole(page);
    await page.goto("/");
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

  test("is rendered by the server from the cookie, so nothing flashes", async ({ request }) => {
    const on = await (await request.get("/", { headers: { cookie: `${ADVANCED_COOKIE}=on` } })).text();
    expect(on).toContain("Committed");
    expect(on).not.toContain('data-testid="rules-summary"');

    const off = await (await request.get("/")).text();
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

  test("a deep link to Advanced-only content shows it with a note in the default view", async ({ page }) => {
    const problems = watchConsole(page);
    await page.goto("/#rule-meters");
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
    await page.goto("/#rule-meters");
    await expect(page.getByText("Committed", { exact: true })).toBeVisible();
    await expect(page.getByTestId("advanced-note")).toHaveCount(0);
  });
});

test.describe("phone menu on a slow device", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a tap on the menu while the page is still hydrating opens it, without a hydration error", async ({
    page,
  }) => {
    const problems = watchConsole(page);
    // A slow phone: the shell hydrates first and the page's own boundary later, which leaves a window in
    // which the menu button works but the page below it has not hydrated yet.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
    await page.goto("/", { waitUntil: "commit" });
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
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(problems).toEqual([]);
  });
});

test.describe("keyboard", () => {
  test("the Advanced view switch toggles with Space", async ({ page }) => {
    await page.goto("/");
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
