/**
 * The pieces of the per-call deadline (issue #105): the deadline itself, the waits it can cut (locks,
 * replays, shared work) and the payment it must never cut once signed.
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createSignalsApp } from "@mandate/signals";
import { FakeGatewayFacilitator } from "@mandate/signals/testing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallDeadline,
  CallStopped,
  COMMIT_GRACE_MS,
  describeStop,
  NotEnoughTime,
  type Stop,
} from "../src/mcp/deadline";
import type { PaymentReporter } from "../src/console/payment-reports";
import { scopedServices } from "../src/mcp/scoped-services";
import type { Services } from "../src/services";
import { ProposalLedger } from "../src/state/ledger";
import { PlanStore } from "../src/state/plans";
import { SharedWork } from "../src/support/shared-work";
import { PaymentNotSentError, PaymentOutcomeUnknownError, X402Buyer } from "../src/x402/buyer";

const t0 = new Date("2026-11-15T12:00:00.000Z");

/** A promise that never settles on its own, rejecting when `signal` aborts. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });
}

function stopOf(deadline: CallDeadline): Stop {
  const stop = deadline.stop;
  if (stop === undefined) throw new Error("the deadline has not stopped the call");
  return stop;
}

describe("CallDeadline", () => {
  it("aborts its signal at the deadline and names the step that waited longest", async () => {
    const stops: Stop[] = [];
    const deadline = new CallDeadline({ budgetMs: 80, onStop: (stop) => stops.push(stop) });
    const first = deadline.step("gemini.ladder", hang);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = deadline.step("gemini.spot", hang);
    await expect(first).rejects.toBeInstanceOf(CallStopped);
    await expect(second).rejects.toBeInstanceOf(CallStopped);
    expect(stops).toHaveLength(1);
    const stop = stopOf(deadline);
    expect(stop).toMatchObject({ reason: "deadline", step: "gemini.ladder", alsoWaiting: ["gemini.spot"] });
    expect(stop.stepMs).toBeGreaterThanOrEqual(60);
    expect(describeStop(stop, deadline.budgetMs)).toBe(
      "Gemini's public market data did not answer within this call's 0.1 s limit (the strike ladder and its order books).",
    );
    // Nothing new starts once the call is over.
    await expect(deadline.step("chain.snapshot", () => Promise.resolve(1))).rejects.toBeInstanceOf(
      CallStopped,
    );
  });

  it("stops at once, as client_gone, when the client goes away", async () => {
    const client = new AbortController();
    const deadline = new CallDeadline({ budgetMs: 60_000, clientSignal: client.signal });
    const waiting = deadline.step("console.context", hang);
    client.abort();
    await expect(waiting).rejects.toBeInstanceOf(CallStopped);
    expect(stopOf(deadline)).toMatchObject({ reason: "client_gone", step: "console.context" });
    deadline.dispose();
  });

  it("starts work that cannot be cut only with enough time left, and reports it until it ends", async () => {
    const deadline = new CallDeadline({ budgetMs: 1_000 });
    expect(() => deadline.beginCommit(5_000)).toThrow(NotEnoughTime);
    expect(deadline.committing()).toBe(false);
    const { end, bound } = deadline.beginCommit(500);
    expect(deadline.committing()).toBe(true);
    let settled = false;
    const waiting = deadline.commitsSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    end();
    end();
    await waiting;
    expect(deadline.committing()).toBe(false);
    expect(bound.aborted).toBe(false);
    deadline.dispose();
  });

  it("bounds a commit at the rest of the budget plus COMMIT_GRACE_MS, past the deadline", async () => {
    const deadline = new CallDeadline({ budgetMs: 100 });
    const { bound, end } = deadline.beginCommit(50);
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The deadline has passed, and the commit is still allowed to finish.
    expect(deadline.stop?.reason).toBe("deadline");
    expect(bound.aborted).toBe(false);
    await new Promise<void>((resolve) => {
      bound.addEventListener("abort", () => {
        resolve();
      });
    });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(100 + COMMIT_GRACE_MS - 50);
    expect(waited).toBeLessThan(100 + COMMIT_GRACE_MS + 1_000);
    end();
  });

  it("refuses to begin a commit once the call is stopped", async () => {
    const deadline = new CallDeadline({ budgetMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(() => deadline.beginCommit(0)).toThrow(CallStopped);
  });
});

describe("work after a commit", () => {
  it("payment reports never throw, even once the call is stopped, so a paid signal is never lost", async () => {
    const deadline = new CallDeadline({ budgetMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deadline.stop).toBeDefined();
    let reported = 0;
    const reports = {
      reportPurchase: () => {
        reported += 1;
        return Promise.resolve(true);
      },
      syncBudget: () => {
        reported += 1;
        return Promise.resolve(true);
      },
    } as unknown as PaymentReporter;
    const scoped = scopedServices({ paymentReports: reports } as unknown as Services, deadline);
    await expect(scoped.paymentReports?.reportPurchase("0xabc")).resolves.toBe(false);
    await expect(scoped.paymentReports?.syncBudget()).resolves.toBe(false);
    // Nothing was sent now; the reporter's own background flush sends it later.
    expect(reported).toBe(0);
  });
});

describe("waits the deadline can cut", () => {
  it("PlanStore: a caller that gives up waiting never runs, and does not block the next one", async () => {
    const store = new PlanStore();
    let release: () => void = () => undefined;
    const holder = store.exclusive(
      "ladder",
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve("holder");
          };
        }),
    );
    const giveUp = new AbortController();
    let ranLate = false;
    const quitter = store.exclusive(
      "ladder",
      () => {
        ranLate = true;
        return Promise.resolve("quitter");
      },
      {
        whileWaiting: (wait) => Promise.race([wait, hang(giveUp.signal)]),
      },
    );
    const next = store.exclusive("ladder", () => Promise.resolve("next"));
    giveUp.abort(new Error("deadline"));
    await expect(quitter).rejects.toThrow("deadline");
    release();
    await expect(holder).resolves.toBe("holder");
    await expect(next).resolves.toBe("next");
    expect(ranLate).toBe(false);
  });

  it("ProposalLedger: a duplicate stops waiting for the running call, which goes on", async () => {
    const ledger = new ProposalLedger();
    let finish: (value: number) => void = () => undefined;
    const first = ledger.once(
      "k",
      t0,
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
      () => true,
    );
    const giveUp = new AbortController();
    const duplicate = ledger.once(
      "k",
      t0,
      () => Promise.resolve(2),
      () => true,
      {
        whileWaiting: (wait) => Promise.race([wait, hang(giveUp.signal)]),
      },
    );
    giveUp.abort(new Error("deadline"));
    await expect(duplicate).rejects.toThrow("deadline");
    finish(1);
    await expect(first).resolves.toMatchObject({ value: 1, replayed: false });
    await expect(
      ledger.once(
        "k",
        t0,
        () => Promise.resolve(3),
        () => true,
      ),
    ).resolves.toMatchObject({
      value: 1,
      replayed: true,
    });
  });

  it("SharedWork: aborts the run only when its last waiter gives up", async () => {
    const runs: AbortSignal[] = [];
    const work = new SharedWork<string>((signal) => {
      runs.push(signal);
      return hang(signal);
    });
    const a = new AbortController();
    const b = new AbortController();
    const first = work.join(a.signal);
    const second = work.join(b.signal);
    expect(runs).toHaveLength(1);
    a.abort(new Error("a gave up"));
    await expect(first).rejects.toThrow("a gave up");
    expect(runs[0]?.aborted).toBe(false);
    b.abort(new Error("b gave up"));
    await expect(second).rejects.toThrow("b gave up");
    expect(runs[0]?.aborted).toBe(true);
    // The next caller starts a fresh run.
    const c = new AbortController();
    const third = work.join(c.signal);
    expect(runs).toHaveLength(2);
    c.abort(new Error("c gave up"));
    await expect(third).rejects.toThrow("c gave up");
  });

  it("SharedWork: a caller without a signal keeps the run going for everyone", async () => {
    let finish: (value: string) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const work = new SharedWork<string>((run) => {
      signal = run;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const giveUp = new AbortController();
    const quitter = work.join(giveUp.signal);
    const patient = work.join();
    giveUp.abort(new Error("gave up"));
    await expect(quitter).rejects.toThrow("gave up");
    expect(signal?.aborted).toBe(false);
    finish("done");
    await expect(patient).resolves.toBe("done");
  });
});

describe("X402Buyer.pay under a deadline", () => {
  const SELLER = privateKeyToAccount(generatePrivateKey()).address;
  const HELLO_URL = "http://signals.test/v1/signal/hello";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The real GatewayClient and signals app, with a gate the test can hold each request at. */
  function setup(gate: (request: Request, index: number) => Promise<void> = () => Promise.resolve()) {
    const facilitator = new FakeGatewayFacilitator();
    const app = createSignalsApp({ sellerAddress: SELLER, facilitator });
    let index = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      await gate(request, index++);
      return app.fetch(request);
    });
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: generatePrivateKey() });
    const sign = vi.spyOn(client.account, "signTypedData");
    return { facilitator, sign, buyer: new X402Buyer(client) };
  }

  it("signs nothing when the check right before signing refuses", async () => {
    const { buyer, sign, facilitator } = setup();
    const attempt = buyer.pay(HELLO_URL, {
      maxPrice: "0.001",
      beforeSigning: () => {
        throw new NotEnoughTime("too late");
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(PaymentNotSentError);
    const error = await attempt.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ stopped: true });
    expect((error as PaymentNotSentError).cause).toBeInstanceOf(NotEnoughTime);
    expect(sign).not.toHaveBeenCalled();
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("gives up while unsigned when the signal aborts, and the abandoned request never signs later", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { buyer, sign } = setup((_request, index) => (index === 0 ? held : Promise.resolve()));
    const stop = new AbortController();
    const attempt = buyer.pay(HELLO_URL, { maxPrice: "0.001", signal: stop.signal });
    stop.abort(new Error("deadline"));
    await expect(attempt).rejects.toMatchObject({ name: "PaymentNotSentError", stopped: true });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sign).not.toHaveBeenCalled();
  });

  it("once signed, ignores the signal and bounds the paid request instead", async () => {
    const { buyer, sign } = setup((_request, index) =>
      index === 1 ? new Promise<void>(() => undefined) : Promise.resolve(),
    );
    const stop = new AbortController();
    const attempt = buyer.pay(HELLO_URL, {
      maxPrice: "0.001",
      signal: stop.signal,
      beforeSigning: () => {
        // The deadline passes right after the check: the signed payment must be followed, not cut.
        setTimeout(() => {
          stop.abort(new Error("deadline"));
        }, 0);
      },
      paidRequestTimeoutMs: 100,
    });
    await expect(attempt).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
