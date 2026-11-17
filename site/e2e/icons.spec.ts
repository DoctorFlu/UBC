import { expect, test, type Page } from "@playwright/test";

import { TEST_SITE_URL } from "../playwright.config";

/** Every icon and link preview image the page's head declares, as written in the HTML. */
async function declaredImages(page: Page): Promise<{ icons: string[]; previews: string[] }> {
  return page.evaluate(() => ({
    icons: [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]'),
    ].map((link) => link.getAttribute("href") ?? ""),
    previews: [
      ...document.querySelectorAll<HTMLMetaElement>('meta[property="og:image"], meta[name="twitter:image"]'),
    ].map((meta) => meta.content),
  }));
}

async function expectImage(page: Page, url: string): Promise<void> {
  const response = await page.request.get(url);
  expect(response.status(), url).toBe(200);
  expect(response.headers()["content-type"], url).toMatch(/^image\//);
  expect((await response.body()).length, url).toBeGreaterThan(0);
}

test("the icons and the link preview image answer with images", async ({ page }) => {
  await page.goto("/");
  const { icons, previews } = await declaredImages(page);

  // favicon.ico, icon.svg and apple-icon.png, at the root, as Next's file conventions declare them.
  expect(icons.map((href) => new URL(href, "http://x").pathname).sort()).toEqual([
    "/apple-icon.png",
    "/favicon.ico",
    "/icon.svg",
  ]);
  for (const href of icons) await expectImage(page, href);
  // Browsers ask for /favicon.ico whether or not the page links it.
  await expectImage(page, "/favicon.ico");

  // Link previews need absolute URLs, on the origin the build was given (NEXT_PUBLIC_SITE_URL). This
  // server stands in for that origin, so each is fetched here by its path.
  expect(previews).toHaveLength(2);
  for (const url of previews) {
    expect(url.startsWith(`${TEST_SITE_URL}/`), url).toBe(true);
    const { pathname, search } = new URL(url);
    await expectImage(page, `${pathname}${search}`);
  }
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute("content", "1200");
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute("content", "630");
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
    "content",
    /You hold the breaker/,
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", TEST_SITE_URL);
});
