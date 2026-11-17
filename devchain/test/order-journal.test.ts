/**
 * The console order journal's client (issue #93): it tries again, briefly, when the console cannot take a
 * request yet (it has not seen the intent on chain, did not answer, or failed), and never on a refusal.
 */
import { CONSOLE_EXECUTOR_ROUTES, clientOrderIdFor, type VenueOrderRecord } from "@mandate/shared";
import { describe, expect, it } from "vitest";
import { consoleOrderJournal } from "../src/order-journal";

const POLICY = "0x00000000000000000000000000000000000000aa";

const record: VenueOrderRecord = {
  kind: "venue-order",
  version: 1,
  chainId: 5_042_002,
  policy: POLICY,
  intentId: 17,
  revision: 1,
  venue: "gemini",
  environment: "sandbox",
  clientOrderId: clientOrderIdFor(
    { chainId: 5_042_002, policy: POLICY, deployBlockHash: `0x${"ab".repeat(32)}` },
    17,
  ),
  market: "GEMI-ETH2611202200-HI2800",
  side: "buy",
  outcome: "NO",
  quantityHundredths: 967,
  limitPrice: 31,
  state: "placing",
  venueOrderId: null,
  filledHundredths: 0,
  filledCents: 0,
  detail: null,
  placedAt: "2026-11-17T08:00:00.000Z",
  updatedAt: "2026-11-17T08:00:00.000Z",
};

const consoleError = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: `${code} from the console` } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A console that gives these answers in turn (an Error rejects, like no answer), then 201. */
function scripted(answers: (Response | Error)[]) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const journal = consoleOrderJournal({
    consoleUrl: "http://console.test",
    sign: () => Promise.resolve(`0x${"11".repeat(65)}` as const),
    deployment: { chainId: 5_042_002, policy: POLICY },
    fetch: (input, init) => {
      calls.push(`${init.method ?? "GET"} ${new URL(input).pathname}`);
      const next = answers.shift() ?? new Response("{}", { status: 201 });
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { journal, calls, sleeps };
}

describe("the console order journal", () => {
  it("writes again, briefly, while the console has not seen the intent on chain yet", async () => {
    const { journal, calls, sleeps } = scripted([
      consoleError(409, "not_seen"),
      consoleError(409, "not_seen"),
    ]);
    await journal.put(record);
    expect(calls).toEqual(Array(3).fill(`PUT ${CONSOLE_EXECUTOR_ROUTES.order(17)}`));
    expect(sleeps).toEqual([250, 500]);
  });

  it("tries again when the console does not answer or fails, for a read and a write", async () => {
    const write = scripted([new TypeError("fetch failed"), consoleError(503, "unavailable")]);
    await write.journal.put(record);
    expect(write.sleeps).toEqual([250, 500]);

    const read = scripted([
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
      consoleError(404, "not_found"),
    ]);
    expect(await read.journal.get(17)).toBeNull();
    expect(read.calls).toHaveLength(2);
  });

  it("never tries again after a refusal", async () => {
    for (const [status, code] of [
      [409, "stale"],
      [409, "conflict"],
      [403, "not_executor"],
      [422, "intent_mismatch"],
    ] as const) {
      const { journal, calls, sleeps } = scripted([consoleError(status, code)]);
      await expect(journal.put(record)).rejects.toThrow(
        `the console did not store the order record: ${code}`,
      );
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("gives up after about 8 seconds of waits, saying how many tries it made", async () => {
    const { journal, calls, sleeps } = scripted(
      Array.from({ length: 10 }, () => consoleError(409, "not_seen")),
    );
    await expect(journal.put(record)).rejects.toThrow(/not_seen: not_seen from the console \(6 tries\)$/);
    expect(calls).toHaveLength(6);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 4_000]);
  });
});
