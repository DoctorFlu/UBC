/**
 * The app icons: each app's copy matches brand/icons, and the files are what browsers expect of them.
 * After changing the mark, run `npm run icons -w @mandate/brand` to redraw and copy them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ICON_COPIES, ICON_FILES, ICON_SOURCE } from "./scripts/icon-files";

const source = (file: string) => readFileSync(join(ICON_SOURCE, file));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("app icons", () => {
  it.each(ICON_COPIES.flatMap((dir) => ICON_FILES.map((file) => [dir, file] as const)))(
    "%s%s is the same as brand/icons",
    (dir, file) => {
      expect(readFileSync(join(dir, file)).equals(source(file))).toBe(true);
    },
  );

  it("icon.svg follows the browser's colour scheme", () => {
    const svg = source("icon.svg").toString("utf8");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });

  it("favicon.ico holds 16, 32 and 48 px PNG images", () => {
    const ico = source("favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, index) => {
      const entry = 6 + 16 * index;
      const image = ico.subarray(
        ico.readUInt32LE(entry + 12),
        ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8),
      );
      const { width, height } = pngSize(image);
      expect([ico.readUInt8(entry), ico.readUInt8(entry + 1)]).toEqual([width, height]);
      return width;
    });
    expect(sizes).toEqual([16, 32, 48]);
  });

  it("apple-icon.png is 180 px square", () => {
    expect(pngSize(source("apple-icon.png"))).toEqual({ width: 180, height: 180 });
  });
});
