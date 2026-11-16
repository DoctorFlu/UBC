"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useReducer,
  useRef,
} from "react";

import { cx } from "@/lib/cx";
import {
  DEFAULT_HOLD_CONFIG,
  type HoldConfig,
  type HoldEvent,
  type HoldState,
  IDLE,
  holdReducer,
} from "@/lib/hold-to-confirm";

import { type ButtonSize, buttonClass } from "./Button";
import styles from "./HoldButton.module.css";

export interface HoldButtonProps {
  /** What the button does, e.g. "Pause agent". */
  children: ReactNode;
  /** Shown briefly after confirming, e.g. "Paused". */
  confirmedLabel?: ReactNode;
  /**
   * Shown while armed, waiting for the second press, e.g. "Confirm approval". A bar under it drains
   * over the arm window, so the owner sees how long the second press still counts.
   */
  armedLabel?: ReactNode;
  onConfirm: () => void;
  tone?: "danger" | "ink" | "neutral";
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
  holdMs?: number;
  /** Render the "Hold, or press twice" hint under the button. It is always announced to screen readers. */
  showHint?: boolean;
  className?: string;
  "aria-label"?: string;
}

const variantForTone = { danger: "danger", ink: "primary", neutral: "secondary" } as const;

/**
 * A destructive action that cannot fire by accident: hold it for `holdMs`, or press it twice.
 * Works with pointer, touch, Space, Enter, and screen reader activation. Escape or moving away cancels.
 *
 * The first press never moves or resizes the button: every label shares one grid cell (the button
 * keeps the width of the longest) and the pressed-state shrink of other buttons is off here. Once
 * armed, the label says what the second press does and a bar drains over the arm window.
 */
export function HoldButton({
  children,
  confirmedLabel,
  armedLabel = "Confirm",
  onConfirm,
  tone = "danger",
  size = "md",
  block = false,
  icon,
  disabled = false,
  holdMs = DEFAULT_HOLD_CONFIG.holdMs,
  showHint = false,
  className,
  "aria-label": ariaLabel,
}: HoldButtonProps) {
  const armWindowMs = DEFAULT_HOLD_CONFIG.armWindowMs;
  const config: HoldConfig = { holdMs, armWindowMs };
  const [state, dispatch] = useReducer((s: HoldState, e: HoldEvent) => holdReducer(s, e, config), IDLE);
  // True between our own press and the click the browser fires after it, so that click is not
  // mistaken for a separate (assistive technology) activation.
  const pressHandled = useRef(false);
  const hintId = useId();

  const fireConfirm = useEffectEvent(onConfirm);

  useEffect(() => {
    if (state.phase === "holding") {
      const timer = setTimeout(() => dispatch({ type: "tick", at: performance.now() }), holdMs + 16);
      return () => clearTimeout(timer);
    }
    if (state.phase === "armed") {
      const timer = setTimeout(() => dispatch({ type: "tick", at: performance.now() }), armWindowMs + 16);
      return () => clearTimeout(timer);
    }
    if (state.phase === "confirmed") {
      fireConfirm();
      const timer = setTimeout(() => dispatch({ type: "reset" }), 1600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state, holdMs, armWindowMs]);

  const press = (input: "pointer" | "keyboard") => {
    // Space and Enter are prevented on key down and key up, so no click follows them.
    pressHandled.current = input === "pointer";
    dispatch({ type: "press", at: performance.now(), input });
  };
  const release = () => dispatch({ type: "release", at: performance.now() });
  const cancel = () => dispatch({ type: "cancel" });

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return;
    press("pointer");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      cancel();
      return;
    }
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat && !disabled) press("keyboard");
  };

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    release();
  };

  const onClick = () => {
    if (pressHandled.current) {
      pressHandled.current = false;
      return;
    }
    if (!disabled) dispatch({ type: "activate", at: performance.now() });
  };

  // Every label is rendered in one grid cell so the button keeps the width of the longest: no shift.
  const labels: [HoldState["phase"], ReactNode][] = [
    ["idle", children],
    ["holding", "Keep holding"],
    ["armed", armedLabel],
    ["confirmed", confirmedLabel ?? children],
  ];

  const announcement =
    state.phase === "armed"
      ? `Press again within ${String(armWindowMs / 1000)} seconds to confirm.`
      : state.phase === "confirmed"
        ? typeof confirmedLabel === "string"
          ? confirmedLabel
          : "Confirmed."
        : "";

  return (
    <span className={styles.wrap} data-block={block || undefined}>
      <button
        type="button"
        className={buttonClass({ variant: variantForTone[tone], size, block }, cx(styles.hold, className))}
        data-phase={state.phase}
        data-tone={tone}
        style={
          {
            "--hold-ms": `${holdMs.toString()}ms`,
            "--arm-ms": `${armWindowMs.toString()}ms`,
          } as CSSProperties
        }
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={hintId}
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerLeave={() => state.phase === "holding" && cancel()}
        onPointerCancel={cancel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onClick={onClick}
        onBlur={() => state.phase !== "confirmed" && cancel()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className={styles.fill} aria-hidden />
        <span className={styles.countdown} aria-hidden data-testid="hold-countdown" />
        {icon}
        <span className={styles.labels}>
          {labels.map(([phase, text]) => (
            <span key={phase} data-active={phase === state.phase || undefined}>
              {text}
            </span>
          ))}
        </span>
      </button>
      <span id={hintId} className={showHint ? styles.hint : "visually-hidden"}>
        Hold for {(holdMs / 1000).toFixed(1)} seconds, or press twice.
      </span>
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
    </span>
  );
}
