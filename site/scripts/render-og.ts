/**
 * `npm run og -w @mandate/site`: draws the link preview (Open Graph and Twitter card) image,
 * `src/app/opengraph-image.png`, 1200 by 630, in the page's own look: the headline on the board beside
 * a schedule card whose three breakers show the three answers. Chromium draws it with the brand's fonts
 * and colours. Needs `npx playwright install chromium` once.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const brand = (path: string) => fileURLToPath(new URL(`../../brand/${path}`, import.meta.url));
const font = (file: string) => `data:font/woff2;base64,${readFileSync(brand(`fonts/${file}`)).toString("base64")}`;
const out = fileURLToPath(new URL("../src/app/opengraph-image.png", import.meta.url));

const MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.75" y="2.75" width="16.5" height="18.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="5.5" width="6" height="8" rx="1" fill="currentColor"/><path d="M8 17.5h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// The landing page's sample mandate (features/gate/model.ts): crypto only, max trade $25, the owner signs
// above $20. Three crypto orders against it, one per answer.
const ROWS = [
  { amount: "$18.00", why: "Within every rule", word: "Approved", tone: "approved" },
  { amount: "$22.00", why: "Above your $20.00 signature line", word: "Held for your signature", tone: "held" },
  { amount: "$30.00", why: "<code>over max trade size</code>", word: "Rejected", tone: "rejected" },
];

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face { font-family: Mona; src: url(${font("MonaSans-Variable.woff2")}) format("woff2"); font-weight: 200 900; font-stretch: 75% 125%; }
@font-face { font-family: Martian; src: url(${font("MartianMono-Variable.woff2")}) format("woff2"); font-weight: 100 800; font-stretch: 75% 112.5%; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; background: #e9ebe8; color: #1a1f22; font-family: Mona; display: grid;
  grid-template-columns: 1fr 470px; gap: 56px; padding: 56px 72px; align-items: center; }
.brand { display: flex; align-items: center; gap: 12px; font-size: 34px; font-weight: 700; font-stretch: 85%; }
.brand svg { width: 40px; height: 40px; }
h1 { margin-top: 36px; font-size: 80px; line-height: 0.95; font-weight: 800; font-stretch: 85%; letter-spacing: -0.02em; }
p { margin-top: 24px; font-size: 24px; line-height: 1.3; color: #4d565b; max-width: 30ch; }
.card { background: #fcfcfb; border: 1px solid #cdd2cd; border-radius: 14px; padding: 26px 28px 18px;
  box-shadow: 0 1px 2px rgb(16 20 22 / 0.06); }
.title { font-size: 22px; font-weight: 600; font-stretch: 92%; }
.sub { margin-top: 6px; font-size: 16px; line-height: 1.4; color: #586166; }
ol { list-style: none; padding: 0; margin-top: 14px; }
li { display: grid; grid-template-columns: 22px 1fr auto; gap: 14px; align-items: center; padding: 16px 0; border-top: 1px solid #cdd2cd; }
li:first-child { border-top: 0; }
.amount { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.rule { display: block; font-size: 15px; color: #4d565b; margin-top: 2px; }
.lamp { width: 16px; height: 16px; border-radius: 50%; margin-left: 3px; }
.word { font-size: 17px; font-weight: 700; text-align: right; max-width: 11ch; line-height: 1.15; }
.approved .lamp { background: #2a9d5a; } .approved .word { color: #1b6a3d; }
.held .lamp { background: #bf7a00; } .held .word { color: #8a4f00; }
.rejected .lamp { background: #d93a2b; } .rejected .word { color: #b0261c; }
code { font-family: Martian; font-size: 13px; font-stretch: 87.5%; }
</style></head><body>
<div>
  <div class="brand">${MARK}<span>Mandate</span></div>
  <h1>Your agent trades. You hold the breaker.</h1>
  <p>Trading rules in a contract. Every order your AI agent proposes is approved, held or rejected.</p>
</div>
<div class="card">
  <div class="title">Sample mandate</div>
  <div class="sub">Crypto only, max trade $25.00.<br>You sign anything above $20.00.</div>
  <ol>${ROWS.map(
    (row) =>
      `<li class="${row.tone}"><span class="lamp"></span><span><span class="amount">${row.amount}</span><span class="rule">${row.why}</span></span><span class="word">${row.word}</span></li>`,
  ).join("")}</ol>
</div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  writeFileSync(out, await page.screenshot({ type: "png" }));
  console.log(`preview written to ${out}`);
} finally {
  await browser.close();
}
