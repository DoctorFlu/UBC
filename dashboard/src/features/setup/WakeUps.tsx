"use client";

import type { WakeDeliveryStatus, WakeDeliveryView } from "@mandate/shared";
import { Meter, MeterIndicator, MeterTrack } from "@ui-sdk/react/meter";

import { Card } from "@/components/ui/Card";
import { When } from "@/components/ui/When";
import { formatCount } from "@/lib/format";
import type { ConsoleWakeStatus } from "@/lib/live/types";

import styles from "./WakeUps.module.css";

const STATUS_WORDS: Record<WakeDeliveryStatus, string> = {
  queued: "Waiting",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  capped: "Not sent",
  dropped: "Not sent",
};

function every(ms: number): string {
  if (ms % 60_000 === 0) return ms === 60_000 ? "minute" : `${formatCount(ms / 60_000)} minutes`;
  return `${formatCount(Math.round(ms / 1000))} s`;
}

function WakeRow({ wake }: { wake: WakeDeliveryView }) {
  return (
    <li className={styles.row} data-testid="wake-up" data-kind={wake.kind} data-status={wake.status}>
      <span className={styles.summary}>{wake.summary}</span>
      <span className={styles.meta}>
        <span className={styles.status} data-status={wake.status}>
          {STATUS_WORDS[wake.status]}
        </span>
        {wake.status === "queued" && wake.dueAt ? (
          <span>
            until <When inSentence at={wake.dueAt} />
          </span>
        ) : (
          <When inSentence at={wake.attemptedAt ?? wake.occurredAt} />
        )}
        {wake.result ? <span className={styles.result}>{wake.result}</span> : null}
      </span>
    </li>
  );
}

/**
 * Whether events wake Grok Bot's routine, and the last few wake-ups. Never the webhook's address or
 * key: the server keeps both out of the snapshot.
 */
export function WakeUpsCard({ wake }: { wake: ConsoleWakeStatus }) {
  return (
    <Card
      title="Event wake-ups"
      description="The console starts Grok Bot's routine when the owner acts, an order fills late, an intent is rejected or spot crosses the goal."
      headingLevel={2}
    >
      <div className={styles.body} data-testid="wake-ups" data-enabled={wake.enabled}>
        {wake.enabled ? (
          <>
            <Meter
              className={styles.meter}
              min={0}
              max={Math.max(1, wake.dailyCap)}
              value={wake.leftToday}
              getValueLabel={() =>
                `${formatCount(wake.leftToday)} of ${formatCount(wake.dailyCap)} left today`
              }
              aria-label="Wake-ups left today"
            >
              <span className={styles.meterLabel}>
                On. {formatCount(wake.leftToday)} of {formatCount(wake.dailyCap)} left today (UTC).
              </span>
              <MeterTrack className={styles.track}>
                <MeterIndicator className={styles.fill} />
              </MeterTrack>
            </Meter>
            {wake.recent.length > 0 ? (
              <ol className={styles.list} aria-label="Latest wake-ups">
                {wake.recent.map((item) => (
                  <WakeRow key={item.id} wake={item} />
                ))}
              </ol>
            ) : (
              <p className={styles.muted}>Nothing has woken the routine yet.</p>
            )}
            <p className={styles.muted}>
              Spot is checked against the current goal every {every(wake.priceCheckEveryMs)} while the console
              runs
              {wake.lastPriceCheckAt ? (
                <>
                  , last <When inSentence at={wake.lastPriceCheckAt} />
                </>
              ) : null}
              .{wake.priceProblem ? ` ${wake.priceProblem}` : ""}
            </p>
          </>
        ) : (
          <p className={styles.muted}>Off. {wake.offReason}</p>
        )}
      </div>
    </Card>
  );
}
