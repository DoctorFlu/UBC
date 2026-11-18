// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureSnapshot } from "@/fixtures";
import { LiveConsoleProvider } from "@/lib/live/LiveConsole";
import type { ChainView, ConsoleSnapshot, VenueOrderView } from "@/lib/live/types";

import { ActivityView } from "./ActivityView";
import { IntentDetailView } from "./IntentDetailView";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} }),
  usePathname: () => "/m/demo/activity",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ mandate: "demo" }),
}));
// The owner's buttons sign with a wallet; what these tests read is beside them.
vi.mock("@/components/domain/ApprovalActions", () => ({ ApprovalActions: () => null }));

beforeAll(() => {
  Element.prototype.getAnimations = () => [];
  Element.prototype.scrollIntoView = function () {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
});

afterEach(cleanup);

function chainOf(snapshot: ConsoleSnapshot): ChainView {
  if (!snapshot.chain) throw new Error("the fixture has a chain");
  return snapshot.chain;
}

/**
 * The fixture as hosted reads today: fills by the simulated venue with no journal rows, one order that
 * did not fill, rejections. Without the held intent, so Activity opens on All.
 */
function hostedShaped(): ConsoleSnapshot {
  const chain = chainOf(fixtureSnapshot);
  return {
    ...fixtureSnapshot,
    chain: {
      ...chain,
      intents: chain.intents.filter((intent) => intent.status !== "needs_approval"),
      venueOrders: {},
    },
  };
}

function order(patch: Partial<VenueOrderView>): VenueOrderView {
  return {
    venue: "gemini",
    environment: "sandbox",
    state: "filled",
    venueOrderId: "7001",
    clientOrderId: "mandate-0",
    quantityHundredths: 3_900,
    filledHundredths: 3_900,
    filledCents: 1_209,
    feeCents: 20,
    detail: null,
    updatedAt: "2026-11-15T14:20:00.000Z",
    ...patch,
  };
}

/**
 * On Gemini's sandbox: #0 filled 20 of its 39 contracts; #1 filled in full at Gemini and is not recorded
 * onchain yet; #2 rested and was cancelled with nothing filled.
 */
function onGemini(): ConsoleSnapshot {
  const base = hostedShaped();
  const chain = chainOf(base);
  return {
    ...base,
    chain: {
      ...chain,
      intents: chain.intents.map((intent) =>
        intent.id === 0
          ? { ...intent, filledCents: 620 }
          : intent.id === 1
            ? { ...intent, status: "approved", filledCents: null, pnlCents: null }
            : intent,
      ),
      events: chain.events.flatMap((event): ChainView["events"] => {
        if (event.type !== "ResultRecorded") return [event];
        if (event.intentId === 1) return [];
        return event.intentId === 0 ? [{ ...event, filledCents: 620 }] : [event];
      }),
      venueOrders: {
        0: order({
          state: "partly_filled",
          filledHundredths: 2_000,
          filledCents: 620,
          detail: "20 of 39 contracts filled on Gemini's sandbox, the rest cancelled",
        }),
        1: order({
          clientOrderId: "mandate-1",
          quantityHundredths: 5_900,
          filledHundredths: 5_900,
          filledCents: 1_298,
        }),
        2: order({
          clientOrderId: "mandate-2",
          state: "cancelled",
          quantityHundredths: 4_900,
          filledHundredths: 0,
          filledCents: 0,
          feeCents: null,
          detail: "cancelled on Gemini's sandbox with nothing filled",
        }),
      },
    },
  };
}

function renderWith(snapshot: ConsoleSnapshot, view: "activity" | number) {
  return render(
    <LiveConsoleProvider initial={snapshot} follow={false}>
      {view === "activity" ? <ActivityView /> : <IntentDetailView intentId={view} />}
    </LiveConsoleProvider>,
  );
}

function activityRow(id: number): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(`#${id.toString()}`) !== null);
  if (!row) throw new Error(`no row for intent #${id.toString()}`);
  return row;
}

const chipOf = (scope: HTMLElement) => scope.querySelector<HTMLElement>("[data-status]");

describe("a snapshot shaped like hosted's reads as before", () => {
  it("Activity: the contract's words on every chip, and failed now reads Not filled", () => {
    renderWith(hostedShaped(), "activity");
    const chips = [0, 1, 2, 3, 4, 5].map((id) => chipOf(activityRow(id)));
    expect(chips.map((chip) => chip?.textContent)).toEqual([
      "Executed",
      "Executed",
      "Not filled",
      "Rejected, reason rejected by user",
      "Rejected, reason over max trade size",
      "Rejected, reason category not allowed",
    ]);
    expect(chips.map((chip) => chip?.dataset.fill ?? null)).toEqual([null, null, null, null, null, null]);
    expect(chips[0]?.title).toBe("Approved, and the executor recorded a fill.");
    expect(chips[2]?.title).toBe("Approved, but the executor recorded that the order did not fill.");
    expect(within(activityRow(0)).getByTestId("order-summary").textContent).toBe("Buy NO, 40 at 31¢");
    expect(screen.getByText(/fills recorded/).textContent).toMatch(/^2 fills recorded(?!,)/);
  });

  it("the intent page: the same description, order and steps as before", () => {
    renderWith(hostedShaped(), 0);
    expect(chipOf(document.body)?.textContent).toBe("Executed");
    expect(screen.getByText(/Approved, and the executor recorded a fill\.$/)).toBeTruthy();
    expect(screen.getByTestId("order-summary").textContent).toBe("Buy NO, 40 at 31¢");
    const timeline = screen.getByTestId("intent-timeline");
    expect(timeline.textContent).toContain("FilledSimulated fillThe executor recorded a fill of $12.40.");
    cleanup();
    renderWith(hostedShaped(), 2);
    expect(screen.getByTestId("intent-timeline").textContent).toContain(
      "Did not fillThe executor recorded that the order did not fill; its amount went back to the budget.",
    );
  });
});

describe("what the executor's journal adds", () => {
  it("Activity: a partial fill, a fill not recorded yet, and an order that rested unfilled", () => {
    renderWith(onGemini(), "activity");
    const partial = chipOf(activityRow(0));
    expect(partial?.textContent).toBe("Partly filled");
    expect(partial?.dataset.status).toBe("executed");
    expect(partial?.dataset.fill).toBe("partly_filled");
    expect(partial?.title).toBe(
      "Partly filled: 20 of 39 contracts, $6.20 of $12.40. The rest was cancelled and its budget released.",
    );
    expect(within(activityRow(0)).getByTestId("order-summary").textContent).toBe(
      "Buy NO, 20 of 39 filled at 31¢",
    );

    const recording = chipOf(activityRow(1));
    expect(recording?.textContent).toBe("Filled at Gemini sandbox");
    expect(recording?.dataset.status).toBe("approved");
    expect(recording?.title).toBe("Filled at Gemini sandbox; recording the result onchain.");

    const unfilled = chipOf(activityRow(2));
    expect(unfilled?.textContent).toBe("Not filled");
    expect(unfilled?.title).toBe(
      "Not filled: the order rested on Gemini sandbox and was cancelled with nothing filled. Its amount went back to the budget.",
    );
    expect(screen.getByText(/fills? recorded/).textContent).toMatch(/^1 fill recorded, 1 partly filled(?!,)/);
  });

  it("the intent page of a partial fill: chip, sentence, order line and its onchain step", () => {
    renderWith(onGemini(), 0);
    expect(chipOf(document.body)?.textContent).toBe("Partly filled");
    // Under the title, after the market's name; the step below says it again.
    expect(screen.getByRole("heading", { level: 1 }).nextElementSibling?.textContent).toMatch(
      /^BTC .*\. Partly filled: 20 of 39 contracts, \$6\.20 of \$12\.40\. The rest was cancelled and its budget released\.$/,
    );
    expect(screen.getByTestId("order-summary").textContent).toBe("Buy NO, 20 of 39 filled at 31¢");
    expect(screen.getByTestId("intent-timeline").textContent).toContain(
      "Partly filledSandbox fill20 of 39 contracts, $6.20 of $12.40. The rest was cancelled and its budget released.",
    );
  });

  it("the intent page of a fill not recorded yet: a journal step, never shown as onchain", () => {
    renderWith(onGemini(), 1);
    expect(chipOf(document.body)?.textContent).toBe("Filled at Gemini sandbox");
    const timeline = screen.getByTestId("intent-timeline");
    const steps = within(timeline).getAllByRole("listitem");
    const last = steps.at(-1);
    expect(last?.textContent).toContain("Filled at Gemini sandbox; recording the result onchain");
    expect(last?.textContent).toContain("From the executor’s journal, not onchain yet");
    expect(last?.querySelector("a")).toBeNull();
  });

  it("the intent page of an order that rested unfilled says so in its step", () => {
    renderWith(onGemini(), 2);
    expect(screen.getByTestId("intent-timeline").textContent).toContain(
      "Did not fillThe order rested on Gemini sandbox and was cancelled with nothing filled. Its amount went back to the budget.",
    );
  });
});
