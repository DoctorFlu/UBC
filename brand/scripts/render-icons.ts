/**
 * `npm run icons -w @mandate/brand`: draws the app icons from the Mandate mark and writes them to
 * `brand/icons/`, where the console and the landing page link them from their `app/` folders.
 *
 * The mark is the one in the console's sidebar and the site's header: a breaker plate with its handle
 * up. Here it is redrawn on a 32-unit grid so its strokes land on whole pixels at 16 and 32 px.
 *
 * - icon.svg        transparent, ink on light browser chrome and light on dark (prefers-color-scheme)
 * - favicon.ico     16, 32 and 48 px PNGs of the mark on an ink tile, for browsers without SVG icons
 * - apple-icon.png  180 px, full bleed (iOS rounds the corners itself)
 *
 * It also writes review sheets to `brand/docs/`: every icon at 16, 32 and 180 px on light and dark
 * tab-strip colours, and the small ones enlarged.
 *
 * Chromium draws the PNGs, so they match what a browser makes of the SVG. Needs
 * `npx playwright install chromium` once.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const OUT = fileURLToPath(new URL("../icons/", import.meta.url));
const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));
mkdirSync(OUT, { recursive: true });
mkdirSync(DOCS, { recursive: true });

const INK = "#1a1f22";
const ON_INK = "#f6f7f5";
const DARK_TEXT = "#e8ecea";

interface Geometry {
  plate: { x: number; y: number; width: number; height: number; rx: number };
  handle: { x: number; y: number; width: number; height: number };
  line: { x: number; y: number; length: number };
}

/** Filling the icon: for icon.svg, which has no background. */
const FULL: Geometry = {
  plate: { x: 5, y: 3, width: 22, height: 26, rx: 3 },
  handle: { x: 12, y: 8, width: 8, height: 10 },
  line: { x: 10, y: 25, length: 12 },
};

/** Inside an ink tile, with a margin. Strokes sit on odd units, so they fill whole pixels at 16 px. */
const TILED: Geometry = {
  plate: { x: 7, y: 5, width: 18, height: 22, rx: 2 },
  handle: { x: 12, y: 8, width: 8, height: 10 },
  line: { x: 10, y: 23, length: 12 },
};

/** The mark: plate (2-unit stroke), handle up, and the rating line. */
function mark(color: string, { plate, handle, line }: Geometry): string {
  const n = (value: number) => String(value);
  return [
    `<g fill="none" stroke="${color}" stroke-width="2">`,
    `<rect x="${n(plate.x)}" y="${n(plate.y)}" width="${n(plate.width)}" height="${n(plate.height)}" rx="${n(plate.rx)}"/>`,
    `<rect x="${n(handle.x)}" y="${n(handle.y)}" width="${n(handle.width)}" height="${n(handle.height)}" rx="1" fill="${color}" stroke="none"/>`,
    `<path d="M${n(line.x)} ${n(line.y)}h${n(line.length)}"/>`,
    `</g>`,
  ].join("");
}

const iconSvg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`,
  `<style>.m{color:${INK}}@media (prefers-color-scheme: dark){.m{color:${DARK_TEXT}}}</style>`,
  `<g class="m">${mark("currentColor", FULL)}</g>`,
  `</svg>`,
  "",
].join("\n");

/** The mark on an ink tile: readable on any chrome without a colour-scheme query. */
function tileSvg(size: number, radius: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 32 32">`,
    `<rect width="32" height="32" rx="${String(radius)}" fill="${INK}"/>`,
    mark(ON_INK, TILED),
    `</svg>`,
  ].join("");
}

/** An .ico holding PNG images, which every browser that reads .ico accepts. */
function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map(({ data }) => data)]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (svg: string, size: number): Promise<Buffer> => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><img width="${String(size)}" height="${String(size)}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`,
    );
    await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };

  writeFileSync(join(OUT, "icon.svg"), iconSvg);
  const pngs: { size: number; data: Buffer }[] = [];
  // One page renders them, so one at a time.
  for (const size of [16, 32, 48]) pngs.push({ size, data: await render(tileSvg(size, 7), size) });
  writeFileSync(join(OUT, "favicon.ico"), ico(pngs));
  writeFileSync(join(OUT, "apple-icon.png"), await render(tileSvg(180, 0), 180));
  console.log(`icons written to ${OUT}`);

  // The review sheet: each icon at the size a browser shows it, on light and dark tab-strip colours,
  // drawn at 1x, then the same strip enlarged 4x without smoothing so single pixels can be judged.
  for (const scheme of ["light", "dark"] as const) {
    const chrome = scheme === "light" ? "#dee1e6" : "#202124";
    const label = scheme === "light" ? "#3c4043" : "#bdc1c6";
    const data = (file: string, type: string) =>
      `data:${type};base64,${readFileSync(join(OUT, file)).toString("base64")}`;
    const cell = (src: string, size: number, caption: string) =>
      `<figure><img src="${src}" width="${String(size)}" height="${String(size)}"><figcaption>${caption}</figcaption></figure>`;
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 560, height: 240 });
    await page.setContent(`<html style="color-scheme:${scheme}"><body style="margin:0;background:${chrome};font:12px system-ui;color:${label}">
      <style>main{display:flex;gap:24px;align-items:flex-end;padding:24px}figure{margin:0;display:grid;justify-items:center;gap:8px;min-width:64px;line-height:16px}img{display:block}</style>
      <main>
        ${cell(data("icon.svg", "image/svg+xml"), 16, "svg 16")}
        ${cell(data("icon.svg", "image/svg+xml"), 32, "svg 32")}
        ${cell(data("favicon.ico", "image/x-icon"), 16, "ico 16")}
        ${cell(data("favicon.ico", "image/x-icon"), 32, "ico 32")}
        ${cell(data("apple-icon.png", "image/png"), 180, "apple 180")}
      </main></body></html>`);
    await Promise.all((await page.locator("img").all()).map((img) => img.evaluate((el: HTMLImageElement) => el.decode())));
    const sheet = await page.screenshot({ fullPage: true });
    // The four small icons, with a few pixels of tab strip around them.
    const boxes = await Promise.all(
      (await page.locator("img").all()).slice(0, 4).map(async (img) => img.boundingBox()),
    );
    const left = Math.min(...boxes.map((box) => box?.x ?? 0)) - 8;
    const top = Math.min(...boxes.map((box) => box?.y ?? 0)) - 8;
    const right = Math.max(...boxes.map((box) => (box?.x ?? 0) + (box?.width ?? 0))) + 8;
    const bottom = Math.max(...boxes.map((box) => (box?.y ?? 0) + (box?.height ?? 0))) + 8;
    const clip = { x: left, y: top, width: right - left, height: bottom - top };
    const strip = await page.screenshot({ clip });
    await page.setViewportSize({ width: clip.width * 4, height: clip.height * 4 });
    await page.setContent(
      `<body style="margin:0"><img style="image-rendering:pixelated;display:block" width="${String(clip.width * 4)}" height="${String(clip.height * 4)}" src="data:image/png;base64,${strip.toString("base64")}"></body>`,
    );
    await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    const zoom = await page.screenshot();
    writeFileSync(join(DOCS, `icons-${scheme}.png`), sheet);
    writeFileSync(join(DOCS, `icons-${scheme}-zoom.png`), zoom);
  }
  console.log(`review sheets written to ${DOCS}`);
} finally {
  await browser.close();
}
