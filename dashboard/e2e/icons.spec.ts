import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { AGENT_ADDRESS } from "./routes";
import { headReport, watchRebuilds } from "./support/head-report";

/**
 * The hosted console asks for a signed-in session on every path but a short public list in
 * deploy/caddy/app-routes.caddy. A browser fetches tab and home-screen icons without a session, so every
 * icon a page declares must be on the list: read here from the file itself, so a new icon path, or a path
 * dropped from the list, fails this test rather than the hosted sign-in redirect.
 */
const routesFile = fileURLToPath(new URL("../../deploy/caddy/app-routes.caddy", import.meta.url));
const publicLine = /^@public path (.+)$/m.exec(readFileSync(routesFile, "utf8"))?.[1] ?? "";
const PUBLIC_PATHS = publicLine.split(/\s+/).filter(Boolean);

/** Caddy's path matcher: exact, or a prefix when the pattern ends in `*`. */
const isPublic = (path: string) =>
  PUBLIC_PATHS.some((pattern) =>
    pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
  );

async function declaredIcons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]')].map(
      (link) => link.getAttribute("href") ?? "",
    ),
  );
}

test("the icons are images, and public on the hosted console", async ({ page }) => {
  expect(PUBLIC_PATHS).toContain("/favicon.ico");
  const head = watchRebuilds(page);

  // A console page (behind the login when hosted), the public dashboard, and a page that is not there.
  for (const path of ["/", `/agent/${AGENT_ADDRESS}`, "/no-such-page"]) {
    await page.goto(path);
    const icons = await declaredIcons(page);
    const paths = icons.map((href) => new URL(href, "http://x").pathname).sort();
    const expected = ["/apple-icon.png", "/favicon.ico", "/icon.svg"];
    // If they are missing, say what the head held and what `next dev` did (support/head-report.ts).
    const why = paths.join() === expected.join() ? path : `${path}\n${await headReport(page, head)}`;
    expect(paths, why).toEqual(expected);
    for (const href of icons) {
      const { pathname } = new URL(href, "http://x");
      expect(isPublic(pathname), `${pathname} is not in @public in deploy/caddy/app-routes.caddy`).toBe(true);
      const response = await page.request.get(href);
      expect(response.status(), href).toBe(200);
      expect(response.headers()["content-type"], href).toMatch(/^image\//);
    }
  }

  // Browsers ask for /favicon.ico whether or not the page links it.
  const favicon = await page.request.get("/favicon.ico");
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()["content-type"]).toMatch(/^image\//);
});
