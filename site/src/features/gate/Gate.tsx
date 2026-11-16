"use client";

import { categoryLabel, formatCents } from "@mandate/shared/rules";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { NumberInput, NumberInputControl, NumberInputGroup } from "@ui-sdk/react/number-input";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "@ui-sdk/react/slider";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useState } from "react";

import {
  AMOUNT_MAX_CENTS,
  AMOUNT_MIN_CENTS,
  AMOUNT_SLIDER_MAX_CENTS,
  DEFAULT_INPUT,
  GATE_CATEGORIES,
  SAMPLE_RULES,
  clampAmount,
  evaluateGate,
  rowState,
  scheduleRows,
  verdictCopy,
  type GateCategory,
  type GateInput,
  type RowState,
} from "./model";

import styles from "./gate.module.css";

const USD: Intl.NumberFormatOptions = { style: "currency", currency: "USD" };
const USD_WHOLE: Intl.NumberFormatOptions = { ...USD, maximumFractionDigits: 0 };

const SLIDER_MIN = AMOUNT_MIN_CENTS / 100;
const SLIDER_MAX = AMOUNT_SLIDER_MAX_CENTS / 100;

/** Where a dollar value sits along the slider, in percent, for the tick marks under the track. */
function along(dollars: number): string {
  return `${String(((dollars - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100)}%`;
}

const MARKS = [
  { dollars: SAMPLE_RULES.approvalAboveCents / 100, label: "needs you" },
  { dollars: SAMPLE_RULES.maxTradeCents / 100, label: "max" },
];

const GRADUATIONS = Array.from({ length: 8 }, (_, index) => (index + 1) * 5).filter(
  (dollars) => dollars < SLIDER_MAX,
);

const STATE_WORDS: Record<RowState, string> = {
  closed: "Passed",
  tripped: "Stopped here",
  held: "Waits for you",
  idle: "Not checked",
};

function categoryFromValue(value: string | null): GateCategory | null {
  return GATE_CATEGORIES.find((id) => categoryLabel(id) === value) ?? null;
}

/** A breaker as a schematic: plate and handle. Up is closed, down is tripped, half-way is held. */
function Breaker({ state }: { state: RowState }) {
  return (
    <svg className={styles.breaker} data-state={state} viewBox="0 0 20 24" fill="none" aria-hidden="true">
      <rect x="1.75" y="1.75" width="16.5" height="20.5" rx="2.25" />
      <rect className={styles.handle} x="6.5" y="4.5" width="7" height="8" rx="1" />
    </svg>
  );
}

export function Gate() {
  const [input, setInput] = useState<GateInput>(DEFAULT_INPUT);
  const evaluation = evaluateGate(input);
  const verdict = verdictCopy(evaluation, input);
  const rows = scheduleRows(input);
  const dollars = clampAmount(input.amountCents) / 100;

  const setDollars = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) return;
    setInput((current) => ({ ...current, amountCents: clampAmount(value * 100) }));
  };

  // Spoken once per change of verdict or rule, not on every step of a drag.
  const announcement = verdict.code === null ? `${verdict.title}.` : `${verdict.title}: ${verdict.code}.`;

  return (
    <section className={styles.gate} aria-labelledby="gate-title" data-testid="gate">
      <header className={styles.head}>
        <h2 id="gate-title" className={styles.title}>
          Try a trade
        </h2>
        <p className={styles.sample}>Sample mandate</p>
      </header>

      <div className={styles.controls}>
        <Field className={styles.sliderField}>
          <Slider
            className={styles.slider}
            value={Math.min(dollars, SLIDER_MAX)}
            onValueChange={(value) => {
              setDollars(typeof value === "number" ? value : null);
            }}
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            step={1}
            format={USD_WHOLE}
            locale="en-US"
          >
            <div className={styles.sliderHead}>
              <FieldLabel className={styles.label}>Trade size</FieldLabel>
              <output className={`${styles.amount} num`} aria-hidden="true">
                {formatCents(clampAmount(input.amountCents))}
              </output>
            </div>
            <SliderControl className={styles.sliderControl}>
              <SliderTrack className={styles.track}>
                <SliderIndicator className={styles.fill} />
                <SliderThumb className={styles.thumb} />
              </SliderTrack>
            </SliderControl>
            <div className={styles.scale} aria-hidden="true">
              {GRADUATIONS.map((value) => (
                <span key={value} className={styles.graduation} style={{ left: along(value) }} />
              ))}
              {MARKS.map((mark) => (
                <span key={mark.label} className={styles.mark} style={{ left: along(mark.dollars) }}>
                  <span className={`${styles.markLabel} num`}>
                    ${mark.dollars} {mark.label}
                  </span>
                </span>
              ))}
            </div>
          </Slider>
        </Field>

        <div className={styles.row}>
          <Field className={styles.field}>
            <FieldLabel className={styles.label}>Exact amount</FieldLabel>
            <NumberInput
              value={dollars}
              onValueChange={setDollars}
              min={AMOUNT_MIN_CENTS / 100}
              max={AMOUNT_MAX_CENTS / 100}
              step={0.01}
              largeStep={5}
              format={USD}
              locale="en-US"
            >
              <NumberInputGroup className={styles.numberGroup}>
                <NumberInputControl className={`${styles.number} num`} />
              </NumberInputGroup>
            </NumberInput>
          </Field>

          <Field className={styles.field}>
            <FieldLabel className={styles.label}>Market</FieldLabel>
            <SegmentedControl
              className={styles.segmented}
              value={categoryLabel(input.category)}
              onValueChange={(value) => {
                const category = categoryFromValue(value);
                if (category !== null) setInput((current) => ({ ...current, category }));
              }}
            >
              <SegmentedControlIndicator className={styles.segmentedIndicator} />
              {GATE_CATEGORIES.map((id) => (
                <SegmentedControlItem key={id} value={categoryLabel(id)} className={styles.segment}>
                  {categoryLabel(id)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>

          <Field className={`${styles.field} ${styles.switchField}`}>
            <FieldLabel className={styles.label}>Pause agent</FieldLabel>
            <Switch
              className={styles.switch}
              checked={input.paused}
              onCheckedChange={(paused) => {
                setInput((current) => ({ ...current, paused }));
              }}
            >
              <SwitchThumb className={styles.switchThumb} />
            </Switch>
            <FieldDescription className="visually-hidden">The owner&apos;s kill switch.</FieldDescription>
          </Field>
        </div>
      </div>

      <div className={styles.circuit}>
        <h3 className={styles.circuitTitle} id="schedule-title">
          The mandate, in the order the contract checks it
        </h3>
        <ol className={styles.schedule} aria-labelledby="schedule-title" data-testid="schedule">
          {rows.map((row) => {
            const state = rowState(row, evaluation);
            return (
              <li key={row.id} className={styles.rule} data-state={state} data-rule={row.id}>
                <Breaker state={state} />
                <span className={styles.ruleName}>
                  {row.label}
                  <span className={`${styles.rating} num`}>{row.rating}</span>
                </span>
                <span className={styles.ruleState}>{STATE_WORDS[state]}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className={styles.verdict} data-tone={verdict.tone} data-testid="verdict">
        <span className={styles.lamp} aria-hidden="true" />
        <div className={styles.verdictText}>
          <p className={styles.verdictTitle}>{verdict.title}</p>
          <p className={styles.verdictDetail}>{verdict.detail}</p>
          {verdict.code === null ? null : (
            <p className={styles.reason}>
              Contract reason <code>{verdict.code}</code>
            </p>
          )}
        </div>
      </div>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <p className={styles.footnote}>
        This runs <code>evaluateIntent</code>, the rule check the agent and the console use, which a fuzz test
        holds to the contract. Nothing is sent anywhere.
      </p>
    </section>
  );
}
