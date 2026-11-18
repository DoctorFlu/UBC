// @vitest-environment jsdom
import type { CoverNowView } from "@mandate/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AgentPlanView, LadderQuotes } from "@/lib/hedge/types";

import { CoverNowCard } from "./CoverNow";
import { GoalRow, goalTitle } from "./GoalRow";

beforeAll(() => {
  Element.prototype.getAnimations = () => [];
  Element.prototype.scrollIntoView = function () {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

const NOW = Date.parse("2026-11-18T12:00:00Z");
const DAILY = "BTC2611182200";
const WEEKLY = "BTC2611202200";

function goal(eventTicker: string, expiry: string): AgentPlanView {
  return {
    planId: `plan_${eventTicker}`,
    asset: "BTC",
    requestText: "Protect my BTC.",
    createdAt: "2026-11-18T08:00:00.000Z",
    storedAt: "2026-11-18T08:00:01.000Z",
    plan: {
      asset: "BTC",
      eventTicker,
      expiry,
      floorCents: 6_300_000,
      ceilingCents: null,
      spotCents: 6_466_000,
      holdingQuantity: "0.05",
      rungs: [],
      orders: [],
    } as unknown as AgentPlanView["plan"],
  };
}

const goals = [goal(DAILY, "2026-11-18T22:00:00.000Z"), goal(WEEKLY, "2026-11-20T22:00:00.000Z")];

function Row({ states }: { states: Map<string, CoverNowView["state"]> }) {
  const [selected, setSelected] = useState(DAILY);
  return (
    <>
      <GoalRow
        asset="BTC"
        goals={goals}
        states={states}
        selected={selected}
        onSelect={setSelected}
        now={NOW}
      />
      <output data-testid="shown">{selected}</output>
    </>
  );
}

describe("the goal row", () => {
  it("names each goal by when it ends, with its cover, soonest first", () => {
    render(
      <Row
        states={
          new Map([
            [DAILY, "not_met"],
            [WEEKLY, "met"],
          ])
        }
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "BTC goal" });
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      "Through today, 22:00 UTCNot covered",
      "Through Fri 20 NovCovered",
    ]);
    expect(group.textContent).not.toContain(DAILY);
    expect(radios[0]).toHaveProperty("ariaChecked", "true");
  });

  it("says it is measuring a goal whose cover has not arrived", () => {
    render(<Row states={new Map()} />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "Through today, 22:00 UTCMeasuring",
      "Through Fri 20 NovMeasuring",
    ]);
  });

  it("moves to the next goal with the arrow keys, from one tab stop", () => {
    render(<Row states={new Map()} />);
    const [first, second] = screen.getAllByRole("radio");
    if (!first || !second) throw new Error("two goals");
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    act(() => {
      first.focus();
    });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByTestId("shown").textContent).toBe(WEEKLY);
    expect(document.activeElement).toBe(second);
  });

  it("lets an agent find the row by its name and pick a goal", async () => {
    const agent = createAgent();
    render(<Row states={new Map()} />);
    const row = agent.snapshot().find((component) => component.label === "BTC goal");
    expect(row).toMatchObject({ value: DAILY });
    expect(row?.actions).toContain("setValue");
    await act(async () => {
      await agent.act({ steps: [{ ref: "BTC goal", action: "setValue", args: [WEEKLY] }] });
    });
    expect(screen.getByTestId("shown").textContent).toBe(WEEKLY);
    fireEvent.click(screen.getByRole("radio", { name: /Through today/ }));
    expect(screen.getByTestId("shown").textContent).toBe(DAILY);
  });

  it("titles goals in words", () => {
    expect(goalTitle("2026-11-18T22:00:00.000Z", NOW)).toBe("Through today, 22:00 UTC");
    expect(goalTitle("2026-11-20T22:00:00.000Z", NOW)).toBe("Through Fri 20 Nov");
  });
});

describe("cover now before the quotes arrive", () => {
  const weekly = goal(WEEKLY, "2026-11-20T22:00:00.000Z");

  it("says it is measuring on first paint, never that the cover cannot be measured", () => {
    render(<CoverNowCard view={weekly} holdingQuantity="0.05" quotes={null} loading intents={[]} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Measuring cover against Gemini's live quotes…");
    expect(screen.getByTestId("cover-now").getAttribute("data-state")).toBe("measuring");
    expect(screen.getByTestId("cover-now").getAttribute("aria-busy")).toBe("true");
    expect(document.body.textContent).not.toContain("cannot be measured");
  });

  it("says the cover cannot be measured only once a read failed", () => {
    const quotes = null as LadderQuotes | null;
    render(<CoverNowCard view={weekly} holdingQuantity="0.05" quotes={quotes} intents={[]} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Cover cannot be measured now: Gemini's market data for this ladder is unavailable.",
    );
  });
});
