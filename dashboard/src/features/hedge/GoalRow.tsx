"use client";

import { goalEnds } from "@mandate/shared";
import type { CoverNowView } from "@mandate/shared";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";

import { goalStateText } from "@/lib/hedge/goals";
import type { AgentPlanView } from "@/lib/hedge/types";

import styles from "./GoalRow.module.css";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Through today, 22:00 UTC" or "Through Fri 20 Nov": a goal by when it ends, never by its ticker. */
export function goalTitle(expiry: string, now: number): string {
  return capitalize(`through ${goalEnds(expiry, now)}`);
}

/** The asset's goals, soonest first; the one checked is the goal the rest of the page shows. */
export function GoalRow({
  asset,
  goals,
  states,
  selected,
  onSelect,
  now,
}: {
  asset: string;
  goals: readonly AgentPlanView[];
  states: ReadonlyMap<string, CoverNowView["state"]>;
  selected: string;
  onSelect: (eventTicker: string) => void;
  now: number;
}) {
  return (
    <div className={styles.scroller}>
      <SegmentedControl
        className={styles.row}
        aria-label={`${asset} goal`}
        value={selected}
        onValueChange={(next) => {
          if (typeof next === "string") onSelect(next);
        }}
        data-testid="goal-row"
      >
        <SegmentedControlIndicator className={styles.indicator} />
        {goals.map((goal) => (
          <SegmentedControlItem key={goal.plan.eventTicker} value={goal.plan.eventTicker} className={styles.item}>
            <span className={styles.label}>{goalTitle(goal.plan.expiry, now)}</span>
            <span className={styles.state}>{goalStateText(states.get(goal.plan.eventTicker) ?? null)}</span>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}
