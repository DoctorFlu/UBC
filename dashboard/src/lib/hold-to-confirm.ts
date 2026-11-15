/**
 * Hold-to-confirm, as a pure state machine so the timing rules are testable without a DOM.
 *
 * Two ways to confirm, both deliberate:
 * 1. Hold: press (pointer, Space or Enter) and keep holding for `holdMs`.
 * 2. Press twice: any shorter press, or a single click from assistive technology, arms the
 *    control; a second activation within `armWindowMs` confirms. This is the non-hold
 *    alternative for people who cannot hold a key or pointer down.
 *
 * Cancelling (Escape, pointer leaving, focus leaving) returns to idle from any unconfirmed state.
 */

export type HoldInput = "pointer" | "keyboard";

export type HoldState =
  | { readonly phase: "idle" }
  | { readonly phase: "holding"; readonly startedAt: number; readonly input: HoldInput }
  | { readonly phase: "armed"; readonly armedAt: number }
  | { readonly phase: "confirmed"; readonly at: number };

export type HoldEvent =
  /** Pointer down, or Space or Enter key down (not a key repeat). */
  | { readonly type: "press"; readonly at: number; readonly input: HoldInput }
  /** Pointer up, or the key released. */
  | { readonly type: "release"; readonly at: number }
  /** A click that did not come from press and release, such as a screen reader activation. */
  | { readonly type: "activate"; readonly at: number }
  /** Animation frame or timer. */
  | { readonly type: "tick"; readonly at: number }
  | { readonly type: "cancel" }
  | { readonly type: "reset" };

export interface HoldConfig {
  /** How long a hold must last to confirm. */
  readonly holdMs: number;
  /** How long an armed control waits for its second activation. */
  readonly armWindowMs: number;
}

export const DEFAULT_HOLD_CONFIG: HoldConfig = { holdMs: 1200, armWindowMs: 5000 };

export const IDLE: HoldState = { phase: "idle" };

export function holdReducer(
  state: HoldState,
  event: HoldEvent,
  config: HoldConfig = DEFAULT_HOLD_CONFIG,
): HoldState {
  if (event.type === "reset") return IDLE;
  if (state.phase === "confirmed") return state;
  if (event.type === "cancel") return IDLE;

  switch (state.phase) {
    case "idle":
      if (event.type === "press") return { phase: "holding", startedAt: event.at, input: event.input };
      if (event.type === "activate") return { phase: "armed", armedAt: event.at };
      return state;

    case "holding": {
      if (event.type === "tick" || event.type === "release") {
        if (event.at - state.startedAt >= config.holdMs) return { phase: "confirmed", at: event.at };
        return event.type === "release" ? { phase: "armed", armedAt: event.at } : state;
      }
      return state;
    }

    case "armed":
      if (event.type === "press" || event.type === "activate") return { phase: "confirmed", at: event.at };
      if (event.type === "tick" && event.at - state.armedAt > config.armWindowMs) return IDLE;
      return state;
  }
}

/** Hold progress from 0 to 1, for the fill indicator. */
export function holdProgress(
  state: HoldState,
  now: number,
  config: HoldConfig = DEFAULT_HOLD_CONFIG,
): number {
  if (state.phase === "confirmed") return 1;
  if (state.phase !== "holding") return 0;
  return Math.min(1, Math.max(0, (now - state.startedAt) / config.holdMs));
}
