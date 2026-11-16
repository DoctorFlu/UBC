import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { TEST_APP_URL, TEST_SCORECARD_AGENT } from "../playwright.config";

const verdict = (page: Page) => page.getByTestId("verdict");
const rule = (page: Page, id: string) => page.locator(`[data-testid="schedule"] [data-rule="${id}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
});

test("one h1, the landmarks, and links that follow the build's settings", async ({ page }) => {
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("Your agent trades. You hold the breaker.");
  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("contentinfo")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(1);

  for (const link of await page.getByRole("link", { name: "Launch app" }).all()) {
    await expect(link).toHaveAttribute("href", TEST_APP_URL);
  }
  for (const link of await page.getByRole("link", { name: /scorecard/i }).all()) {
    await expect(link).toHaveAttribute("href", `${TEST_APP_URL}/agent/${TEST_SCORECARD_AGENT}`);
  }
  // The repository link is off unless configured.
  await expect(page.getByRole("link", { name: /GitHub/ })).toHaveCount(0);
});

test("never scrolls sideways, from 360 to 1920 px", async ({ page }) => {
  for (const width of [360, 414, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${String(width)} px`).toBeLessThanOrEqual(0);
  }
});

test("the gate works from the keyboard alone", async ({ page }) => {
  await expect(verdict(page)).toContainText("Approved");

  const slider = page.getByRole("slider", { name: "Trade size" });
  await slider.focus();
  for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "$22");
  await expect(verdict(page)).toContainText("Held for your signature");
  await expect(rule(page, "approval")).toHaveAttribute("data-state", "held");

  await page.keyboard.press("End");
  await expect(verdict(page)).toContainText("Rejected");
  await expect(verdict(page)).toContainText("over max trade size");
  await expect(rule(page, "maxTrade")).toHaveAttribute("data-state", "tripped");
  await expect(rule(page, "markets")).toHaveAttribute("data-state", "idle");

  await page.keyboard.press("Home");
  await expect(verdict(page)).toContainText("Approved");

  // Tab order: the slider, the exact amount, the market, the pause switch.
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Exact amount")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("24.5");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Exact amount")).toHaveValue("$24.50");
  await expect(verdict(page)).toContainText("Held for your signature");

  await expect(page.getByRole("radio", { name: "Crypto" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Sports" })).toBeChecked();
  await expect(verdict(page)).toContainText("category not allowed");

  await page.keyboard.press("Tab");
  const pause = page.getByRole("switch", { name: "Pause agent" });
  await expect(pause).toBeFocused();
  await page.keyboard.press("Space");
  await expect(pause).toBeChecked();
  await expect(verdict(page)).toContainText("agent paused");
  await expect(rule(page, "paused")).toHaveAttribute("data-state", "tripped");
});

test("the gate takes a drag on the slider", async ({ page }) => {
  const control = page.locator('[data-slot="slider-control"]');
  const box = await control.boundingBox();
  if (box === null) throw new Error("no slider");
  await page.mouse.click(box.x + box.width * 0.98, box.y + box.height / 2);
  await expect(verdict(page)).toContainText("Rejected");
});

test("announces only the verdict and its reason", async ({ page }) => {
  const live = page.locator('[aria-live="polite"]');
  await expect(live).toHaveText("Approved.");
  await page.getByRole("slider", { name: "Trade size" }).focus();
  await page.keyboard.press("End");
  await expect(live).toHaveText("Rejected: over max trade size.");
});

test("every focusable element shows a focus ring", async ({ page }) => {
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return "none";
      const own = getComputedStyle(element);
      if (own.outlineStyle !== "none" && own.outlineWidth !== "0px") return "own";
      // Some controls draw the ring on a wrapper (:has(:focus-visible)) or a pseudo-element.
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.outlineStyle !== "none" && style.outlineWidth !== "0px") return "wrapper";
      }
      const before = getComputedStyle(element, "::before");
      return before.outlineStyle !== "none" && before.outlineWidth !== "0px" ? "pseudo" : "none";
    });
    expect(ring, `focus stop ${String(index + 1)}`).not.toBe("none");
  }
});

test("the theme toggle flips the scheme and remembers it", async ({ page }) => {
  const scheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await ground();
  const prefersDark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);

  await page.getByRole("button", { name: prefersDark ? "Use light theme" : "Use dark theme" }).click();
  expect(await scheme()).toBe(prefersDark ? "light" : "dark");
  expect(await ground()).not.toBe(before);

  await page.reload();
  expect(await scheme()).toBe(prefersDark ? "light" : "dark");

  // Flipping back to the system's scheme forgets the choice.
  await page.getByRole("button", { name: prefersDark ? "Use dark theme" : "Use light theme" }).click();
  expect(await page.evaluate(() => localStorage.getItem("mandate-theme"))).toBeNull();
});

test("loops the step pictures only when motion is welcome", async ({ page }) => {
  expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("holds still", async ({ page }) => {
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  // Checked on the still page: mid-loop, a fading picture line would be measured at a passing opacity.
  test("has no accessibility violations axe can find", async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  });

  test("passes axe in every gate verdict", async ({ page }) => {
    const amount = page.getByLabel("Exact amount");
    for (const value of ["22", "30"]) {
      await amount.fill(value);
      await amount.press("Enter");
      const results = await new AxeBuilder({ page }).include('[data-testid="gate"]').analyze();
      expect(
        results.violations.map((v) => v.id),
        `$${value}`,
      ).toEqual([]);
    }
    await page.getByRole("switch", { name: "Pause agent" }).click();
    const results = await new AxeBuilder({ page }).include('[data-testid="gate"]').analyze();
    expect(
      results.violations.map((v) => v.id),
      "paused",
    ).toEqual([]);
  });
});

test("fonts load without shifting the layout", async ({ page }) => {
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  const shift = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & { value: number })[])
            total += entry.value;
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => {
          resolve(total);
        }, 500);
      }),
  );
  expect(shift).toBeLessThan(0.01);
});
