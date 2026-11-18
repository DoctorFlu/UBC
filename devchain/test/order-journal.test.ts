/**
 * The console order journal's client (issue #93): it tries again, briefly, when the console cannot take a
 * request yet (it has not seen the intent on chain, did not answer, or failed), and never on a refusal.
 */
import {
  CONSOLE_EXECUTOR_ROUTES,
  clientOrderIdFor,
  type ExecutorVenue,
  type VenueOrderRecord,
} from "@mandate/shared";
import { describe, expect, it } from "vitest";
import { announceUntilAccepted, announceVenue, consoleOrderJournal } from "../src/order-journal";

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

describe("the executor's venue announcement", () => {
  const announcement: ExecutorVenue = {
    kind: "executor-venue",
    version: 1,
    chainId: 5_042_002,
    policy: POLICY,
    venue: "gemini",
    environment: "sandbox",
    announcedAt: "2026-11-18T13:00:00.000Z",
  };
  const answer = (status: number, extra: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        venue: "gemini",
        environment: "sandbox",
        announcedAt: announcement.announcedAt,
        ...extra,
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  /** Announces until accepted against a console giving these answers in turn. */
  async function run(answers: (Response | Error)[]) {
    const lines: string[] = [];
    const sleeps: number[] = [];
    const outcome = await announceUntilAccepted({
      announce: () =>
        announceVenue(
          {
            consoleUrl: "http://console.test",
            sign: () => Promise.resolve(`0x${"11".repeat(65)}` as const),
            fetch: () => {
              const next = answers.shift() ?? answer(500);
              return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
            },
          },
          announcement,
        ),
      policy: POLICY,
      log: (line) => lines.push(line),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    return { outcome, lines, sleeps };
  }

  it("logs every failed attempt with its wait, then the new announcement the console stored", async () => {
    const { outcome, lines, sleeps } = await run([
      consoleError(422, "wrong_deployment"),
      new Error("connect ECONNREFUSED"),
      answer(201, { stored: true, seq: 3, holdsFromBlock: 72_900_001 }),
    ]);
    expect(outcome).toEqual({ accepted: true, stored: true, seq: 3, holdsFromBlock: 72_900_001 });
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(lines).toEqual([
      `[executor] Could not tell the console the venue of ${POLICY} yet (the console answered wrong_deployment: wrong_deployment from the console); attempt 1, trying again in 5 s.`,
      `[executor] Could not tell the console the venue of ${POLICY} yet (the console at http://console.test did not answer (connect ECONNREFUSED)); attempt 2, trying again in 10 s.`,
      `[executor] The console stored the venue of ${POLICY} as announcement #3, holding from block 72900001.`,
    ]);
  });

  it("says when the venue was already in force and nothing was added", async () => {
    const { lines } = await run([answer(200, { stored: false, seq: 2, holdsFromBlock: 72_821_559 })]);
    expect(lines).toEqual([
      `[executor] The console already has this venue in force for ${POLICY} (announcement #2, holding from block 72821559): nothing added.`,
    ]);
  });

  it("reads an older console's answer by its status alone", async () => {
    expect((await run([answer(201)])).lines).toEqual([
      `[executor] The console stored the venue of ${POLICY} as the announcement.`,
    ]);
    expect((await run([answer(200)])).lines).toEqual([
      `[executor] The console already has this venue in force for ${POLICY} (the announcement): nothing added.`,
    ]);
  });

  it("stops at a console that reads another Gemini, which no retry resolves", async () => {
    await expect(run([consoleError(409, "environment_mismatch")])).rejects.toThrow(
      "The console refused this executor: environment_mismatch from the console",
    );
  });
});
