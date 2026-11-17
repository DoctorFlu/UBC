import type { Page } from "@playwright/test";

/**
 * Chrome's "preloaded but not used within a few seconds" hint is a timing report, not a defect:
 * it fires when a loaded machine makes `next dev` slow to serve a page. Everything else counts.
 */
const timingHint = /was preloaded using link preload but not used within a few seconds/;

/** Collects console errors, warnings (hydration mismatches are warnings) and uncaught errors. */
export function watchConsole(page: Page): string[] {
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
