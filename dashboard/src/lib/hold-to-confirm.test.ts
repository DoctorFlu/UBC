import { describe, expect, it } from "vitest";

import {
  type HoldConfig,
  type HoldEvent,
  type HoldState,
  IDLE,
  holdProgress,
  holdReducer,
} from "./hold-to-confirm";

const config: HoldConfig = { holdMs: 1000, armWindowMs: 3000 };

function run(events: HoldEvent[], start: HoldState = IDLE): HoldState {
  return events.reduce((state, event) => holdReducer(state, event, config), start);
}

describe("hold to confirm", () => {
  it("confirms after a full pointer hold, on tick", () => {
    const state = run([
      { type: "press", at: 0, input: "pointer" },
      { type: "tick", at: 500 },
      { type: "tick", at: 1000 },
    ]);
    expect(state).toEqual({ phase: "confirmed", at: 1000 });
  });

  it("confirms when released after the hold time even without a tick", () => {
    const state = run([
      { type: "press", at: 0, input: "keyboard" },
      { type: "release", at: 1200 },
    ]);
    expect(state.phase).toBe("confirmed");
  });

  it("arms instead of confirming on an early release", () => {
    const state = run([
      { type: "press", at: 0, input: "pointer" },
      { type: "release", at: 200 },
    ]);
    expect(state).toEqual({ phase: "armed", armedAt: 200 });
  });

  it("confirms on a second press while armed: the non-hold alternative", () => {
    const state = run([
      { type: "press", at: 0, input: "keyboard" },
      { type: "release", at: 100 },
      { type: "press", at: 900, input: "keyboard" },
    ]);
    expect(state).toEqual({ phase: "confirmed", at: 900 });
  });

  it("supports two assistive-technology activations", () => {
    const state = run([
      { type: "activate", at: 0 },
      { type: "activate", at: 400 },
    ]);
    expect(state.phase).toBe("confirmed");
  });

  it("disarms after the arm window passes", () => {
    const state = run([
      { type: "activate", at: 0 },
      { type: "tick", at: 3001 },
    ]);
    expect(state).toEqual(IDLE);
  });

  it("stays armed within the window", () => {
    const state = run([
      { type: "activate", at: 0 },
      { type: "tick", at: 3000 },
    ]);
    expect(state.phase).toBe("armed");
  });

  it("cancels a hold in progress", () => {
    const state = run([
      { type: "press", at: 0, input: "pointer" },
      { type: "tick", at: 900 },
      { type: "cancel" },
      { type: "tick", at: 2000 },
    ]);
    expect(state).toEqual(IDLE);
  });

  it("cancels an armed control", () => {
    expect(run([{ type: "activate", at: 0 }, { type: "cancel" }])).toEqual(IDLE);
  });

  it("ignores everything except reset once confirmed", () => {
    const confirmed: HoldState = { phase: "confirmed", at: 10 };
    expect(holdReducer(confirmed, { type: "cancel" }, config)).toBe(confirmed);
    expect(holdReducer(confirmed, { type: "press", at: 20, input: "pointer" }, config)).toBe(confirmed);
    expect(holdReducer(confirmed, { type: "reset" }, config)).toEqual(IDLE);
  });

  it("ignores release and tick while idle", () => {
    expect(
      run([
        { type: "release", at: 5 },
        { type: "tick", at: 9 },
      ]),
    ).toEqual(IDLE);
  });

  it("reports progress only while holding", () => {
    const holding: HoldState = { phase: "holding", startedAt: 100, input: "pointer" };
    expect(holdProgress(holding, 100, config)).toBe(0);
    expect(holdProgress(holding, 600, config)).toBe(0.5);
    expect(holdProgress(holding, 5000, config)).toBe(1);
    expect(holdProgress(IDLE, 600, config)).toBe(0);
    expect(holdProgress({ phase: "armed", armedAt: 0 }, 600, config)).toBe(0);
    expect(holdProgress({ phase: "confirmed", at: 0 }, 600, config)).toBe(1);
  });
});
