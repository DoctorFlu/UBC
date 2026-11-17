/**
 * Records small test fixtures from Gemini's public API (no key needed).
 *
 *   npx tsx gemini/scripts/record-fixtures.ts             # record live fixtures
 *   npx tsx gemini/scripts/record-fixtures.ts --from-events <events.json> --ticker <T> --out <file>
 *                                                         # extract one event from a saved events page
 *   npx tsx gemini/scripts/record-fixtures.ts --settled <T>
 *                                                         # record a settled event, outcomes included
 *
 * Responses are trimmed: heavy display fields (rich-text descriptions, image and terms URLs)
 * are removed and only a handful of crypto events are kept, so fixtures stay a few kilobytes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BASE = "https://api.gemini.com";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const HEAVY_KEYS = new Set([
  "description",
  "imageUrl",
  "socialImageUrl",
  "featuredImageUrl",
  "termsLink",
  "termsAndConditionsUrl",
  "participants",
  "color",
  "priceHistory",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function trim(value: Json): Json {
  if (Array.isArray(value)) return value.map(trim);
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!HEAVY_KEYS.has(key)) out[key] = trim(inner);
    }
    return out;
  }
  return value;
}

async function get(path: string): Promise<Json> {
  const response = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return (await response.json()) as Json;
}

function write(name: string, value: Json): void {
  mkdirSync(dirname(name), { recursive: true });
  writeFileSync(name, JSON.stringify(trim(value), null, 2) + "\n");
  console.log(`wrote ${name}`);
}

function asObject(value: Json | undefined): Record<string, Json> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value;
}

function events(page: Json): Record<string, Json>[] {
  const data = asObject(page)["data"];
  if (!Array.isArray(data)) throw new Error("expected data[]");
  return data.map(asObject);
}

function text(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

async function recordLive(): Promise<void> {
  const page = asObject(await get("/v1/prediction-markets/events?status=active&category=Crypto&limit=500"));
  const all = events(page);
  const isLadder = (e: Record<string, Json>) => e["template"] === "prices-ladder";
  const tags = (e: Record<string, Json>) =>
    (Array.isArray(e["eventTags"]) ? e["eventTags"] : []).map((t) => asObject(t)["slug"]);
  const keep = [
    ...all.filter((e) => isLadder(e) && text(e["ticker"]).startsWith("BTC2")),
    ...all.filter((e) => isLadder(e) && text(e["ticker"]).startsWith("ETH2") && tags(e).length === 1),
    ...all.filter((e) => text(e["ticker"]).startsWith("BTC05M")).slice(0, 1),
  ];
  write(join(FIXTURES, "events-crypto.json"), {
    data: keep,
    pagination: { limit: 500, offset: 0, total: keep.length },
  });

  const weekly = keep.find(
    (e) => isLadder(e) && text(e["ticker"]).startsWith("BTC2") && tags(e).length === 1,
  );
  if (weekly === undefined) throw new Error("no weekly BTC ladder found");
  const ticker = text(weekly["ticker"]);
  write(join(FIXTURES, `event-${ticker}.json`), await get(`/v1/prediction-markets/events/${ticker}`));

  const contracts = Array.isArray(weekly["contracts"]) ? weekly["contracts"].map(asObject) : [];
  const symbol = contracts.map((c) => text(c["instrumentSymbol"])).find(Boolean);
  if (symbol !== undefined) write(join(FIXTURES, `book-${symbol}.json`), await get(`/v1/book/${symbol}`));

  write(join(FIXTURES, "pubticker-btcusd.json"), await get("/v1/pubticker/btcusd"));
  write(
    join(FIXTURES, "recently-settled-crypto.json"),
    await get("/v1/prediction-markets/events/recently-settled?category=Crypto&limit=3"),
  );
}

function extract(fromEvents: string, ticker: string, out: string): void {
  const page = JSON.parse(readFileSync(fromEvents, "utf8")) as Json;
  const event = events(page).find((e) => e["ticker"] === ticker);
  if (event === undefined) throw new Error(`${ticker} not in ${fromEvents}`);
  write(out, event);
}

const { values } = parseArgs({
  options: {
    "from-events": { type: "string" },
    ticker: { type: "string" },
    out: { type: "string" },
    settled: { type: "string" },
  },
});

async function recordSettled(ticker: string): Promise<void> {
  const event = asObject(await get(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`));
  if (event["status"] !== "settled") throw new Error(`${ticker} is ${text(event["status"])}, not settled`);
  write(join(FIXTURES, `event-${ticker}-settled.json`), event);
}

if (values.settled !== undefined) {
  await recordSettled(values.settled);
} else if (values["from-events"] !== undefined) {
  if (values.ticker === undefined || values.out === undefined)
    throw new Error("--ticker and --out are required");
  extract(values["from-events"], values.ticker, values.out);
} else {
  await recordLive();
}
