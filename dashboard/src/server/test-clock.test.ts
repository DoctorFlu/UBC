import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readWakeConfig, testConsoleConfig } from "./config";
import { ConsoleService } from "./console-service";
import { openDatabase } from "./db";
import { postWakeClock } from "./http/dev-api";
import { TestClock } from "./test-clock";

const TOKEN = "console-service-token-for-tests-0123456789";
const silent = { info: () => undefined, warn: () => undefined };

describe("TestClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at real speed plus the offset it was moved by", () => {
    let real = 1_000;
    const clock = new TestClock(() => real);
    expect(clock.now()).toBe(1_000);
    clock.advance(600_000);
    real += 5;
    expect(clock.now()).toBe(601_005);
    expect(clock.offsetMs).toBe(600_000);
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
  });

  it("runs a task when it is moved past it, earliest first, and never twice", () => {
    vi.useFakeTimers();
    const clock = new TestClock();
    const ran: string[] = [];
    clock.schedule(() => ran.push("ten minutes"), 600_000);
    clock.schedule(() => ran.push("one minute"), 60_000);
    const cancel = clock.schedule(() => ran.push("cancelled"), 30_000);
    cancel();
    clock.advance(59_999);
    expect(ran).toEqual([]);
    clock.advance(600_000);
    expect(ran).toEqual(["one minute", "ten minutes"]);
    // The real timers were cleared: running them out adds nothing.
    vi.runAllTimers();
    expect(ran).toEqual(["one minute", "ten minutes"]);
  });

  it("still runs a task on time when nobody moves it", () => {
    vi.useFakeTimers();
    const clock = new TestClock();
    const ran: number[] = [];
    clock.schedule(() => ran.push(1), 1_000);
    vi.advanceTimersByTime(1_000);
    expect(ran).toEqual([1]);
  });
});

describe("POST /api/dev/wake-clock", () => {
  function service(testClock: boolean): ConsoleService {
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-wake-clock-"));
    return new ConsoleService(
      testConsoleConfig(dataDir, { serviceToken: TOKEN, wake: { ...readWakeConfig({}), testClock } }),
      openDatabase(dataDir),
      { logger: silent },
    );
  }

  const post = (body: unknown, token: string | null = TOKEN) =>
    new Request("http://console.test/api/dev/wake-clock", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  it("is not there without GROK_WAKE_TEST_CLOCK=on", async () => {
    const consoleService = service(false);
    expect(consoleService.wakeClock).toBeNull();
    const response = await postWakeClock(post({ advanceMs: 600_000 }), consoleService);
    expect(response.status).toBe(404);
  });

  it("needs the service token and a forward move", async () => {
    const consoleService = service(true);
    expect((await postWakeClock(post({ advanceMs: 1_000 }, null), consoleService)).status).toBe(401);
    expect((await postWakeClock(post({ advanceMs: 1_000 }, "wrong"), consoleService)).status).toBe(401);
    expect((await postWakeClock(post({ advanceMs: -1 }), consoleService)).status).toBe(422);
    expect(consoleService.wakeClock?.offsetMs).toBe(0);
  });

  it("moves the wake-ups' clock forward", async () => {
    const consoleService = service(true);
    const response = await postWakeClock(post({ advanceMs: 600_000 }), consoleService);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ offsetMs: 600_000 });
    expect(consoleService.wakeClock?.offsetMs).toBe(600_000);
  });
});
