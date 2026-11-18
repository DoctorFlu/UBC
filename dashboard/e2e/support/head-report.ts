import { execFileSync } from "node:child_process";

import type { Page } from "@playwright/test";

/**
 * What to read when a check on the document's head fails: twice a smoke run found the head with no
 * <title> and no icons for a moment, right after "[Fast Refresh] rebuilding", and no probe has made that
 * happen on purpose. When such a check fails, its message carries the head as it was, every rebuild
 * `next dev` announced to the page, and whether the checkout `next dev` serves had uncommitted changes.
 */
export interface HeadWatch {
  /** "[Fast Refresh]" lines the page logged, each with the time it was logged. */
  rebuilds: string[];
}

/** Starts recording the rebuilds `next dev` announces to the page. Call it before the page loads. */
export function watchRebuilds(page: Page): HeadWatch {
  const watch: HeadWatch = { rebuilds: [] };
  page.on("console", (message) => {
    if (message.text().includes("[Fast Refresh]")) {
      watch.rebuilds.push(`${new Date().toISOString()} ${message.text()}`);
    }
  });
  return watch;
}

/** The head's titles and icon links now, the rebuilds seen, and how many paths of the checkout are changed. */
export async function headReport(page: Page, watch: HeadWatch): Promise<string> {
  const head = await page
    .evaluate(() => ({
      titles: [...document.querySelectorAll("title")].map((title) => title.textContent),
      documentTitle: document.title,
      icons: [
        ...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]'),
      ].map((link) => `${link.rel} ${link.getAttribute("href") ?? ""}`),
    }))
    .catch((error: unknown) => ({ error: String(error) }));
  return [
    `at ${new Date().toISOString()}, on ${page.url()}`,
    `head: ${JSON.stringify(head)}`,
    `rebuilds next dev announced: ${watch.rebuilds.length > 0 ? watch.rebuilds.join("; ") : "none"}`,
    `changed paths in the checkout: ${changedPaths()}`,
  ].join("\n");
}

/** `git status --porcelain`'s line count for the checkout under test, with the first few paths. */
function changedPaths(): string {
  try {
    const lines = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", timeout: 10_000 })
      .split("\n")
      .filter(Boolean);
    return lines.length === 0 ? "0" : `${lines.length.toString()} (${lines.slice(0, 5).join(", ")})`;
  } catch (error) {
    return `unknown (${String(error)})`;
  }
}
