import type { ExecutorContract } from "@mandate/shared";
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/executor";
import { startExecutorFleet } from "../src/executor-fleet";

const OWN: ExecutorContract = { chainId: 5_042_002, policy: `0x${"aa".repeat(20)}`, deployBlock: 1 };
const OTHER: ExecutorContract = { chainId: 5_042_002, policy: `0x${"bb".repeat(20)}`, deployBlock: 7 };
const FOREIGN: ExecutorContract = { chainId: 5_042_002, policy: `0x${"cc".repeat(20)}`, deployBlock: 9 };

function fakeExecutor(stopped: string[], policy: string): Executor {
  return {
    stop: () => {
      stopped.push(policy);
    },
    settleNow: () => Promise.resolve(),
  };
}

describe("the executor fleet (#95: one key, every mandate's contract)", () => {
  it("serves the server's contract without the console, and each listed contract once", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    let listing: ExecutorContract[] | Error = new Error("the console is starting");
    const fleet = startExecutorFleet({
      always: [OWN],
      discover: () => (listing instanceof Error ? Promise.reject(listing) : Promise.resolve(listing)),
      start: (contract) => {
        started.push(contract.policy);
        return Promise.resolve(fakeExecutor(stopped, contract.policy));
      },
      intervalMs: 60_000,
      log: () => undefined,
    });
    await fleet.refresh();
    expect(fleet.serving()).toEqual([`5042002:${OWN.policy}`]);
    listing = [OWN, OTHER];
    await fleet.refresh();
    await fleet.refresh();
    expect(started).toEqual([OWN.policy, OTHER.policy]);
    expect(fleet.serving()).toEqual([`5042002:${OWN.policy}`, `5042002:${OTHER.policy}`]);
    // The console going away later stops nothing that is served.
    listing = new Error("the console is down");
    await fleet.refresh();
    expect(fleet.serving()).toHaveLength(2);
    fleet.stop();
    expect(stopped.sort()).toEqual([OWN.policy, OTHER.policy].sort());
  });

  it("asks a refused contract again only after a while, and logs the refusal once", async () => {
    let clock = 0;
    const lines: string[] = [];
    let refusals = 0;
    const fleet = startExecutorFleet({
      discover: () => Promise.resolve([FOREIGN]),
      start: () => {
        refusals += 1;
        return Promise.resolve({ refused: "its executor is another key" });
      },
      intervalMs: 60_000,
      retryRefusedMs: 1_000,
      now: () => clock,
      log: (line) => lines.push(line),
    });
    await fleet.refresh();
    await fleet.refresh();
    expect(refusals).toBe(1);
    clock = 1_001;
    await fleet.refresh();
    expect(refusals).toBe(2);
    expect(lines.filter((line) => line.includes("not serving"))).toHaveLength(1);
    expect(fleet.serving()).toEqual([]);
    fleet.stop();
  });

  it("tries a contract that failed to start again on the next round", async () => {
    let fail = true;
    const fleet = startExecutorFleet({
      discover: () => Promise.resolve([OTHER]),
      start: (contract) =>
        fail
          ? Promise.reject(new Error("the chain did not answer"))
          : Promise.resolve(fakeExecutor([], contract.policy)),
      intervalMs: 60_000,
      log: () => undefined,
    });
    await fleet.refresh();
    expect(fleet.serving()).toEqual([]);
    fail = false;
    await fleet.refresh();
    expect(fleet.serving()).toEqual([`5042002:${OTHER.policy}`]);
    fleet.stop();
  });
});
