"use client";

import type { PayoffPoint } from "@mandate/planner";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

import { formatUsdCents, formatUsdCentsDelta } from "@/lib/format";

import styles from "./hedge.module.css";

const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 34, left: 64 };

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

/** Round tick steps (1, 2, 5 times a power of ten) giving about `count` ticks over `span`. */
function niceStep(span: number, count: number): number {
  const raw = Math.max(1, span / count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

function ticks(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min, count);
  const values: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) values.push(value);
  return values;
}

/** "$65k" style labels for the price axis, exact dollars when a tick is not a whole thousand. */
function priceTick(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 1_000 && dollars % 1_000 === 0 ? `$${(dollars / 1_000).toString()}k` : usd(cents);
}

export interface PayoffChartProps {
  asset: string;
  /** The planner's payoff table, lowest price first, drawn exactly as given. */
  points: readonly PayoffPoint[];
  spotCents: number;
  /** Strikes of the rungs bought, for the tick marks under the axis. */
  strikesCents: readonly number[];
  /** Index into `points` the readout starts on. */
  initialIndex?: number;
}

/**
 * Profit and loss at settlement, by where the asset settles: the holding alone, the hedge alone (payout
 * minus cost) and the two combined. Every vertex is a point of the planner's own payoff table, which
 * carries each strike and the cent below it, so the steps sit exactly where the contracts pay. The
 * readout above the chart shows the exact figures of the point under the pointer or the arrow keys.
 */
export function PayoffChart({ asset, points, spotCents, strikesCents, initialIndex }: PayoffChartProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState(() =>
    Math.min(Math.max(0, initialIndex ?? 0), Math.max(0, points.length - 1)),
  );

  useEffect(() => {
    const node = frame.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;

  const xMin = first.priceCents;
  const xMax = last.priceCents;
  const values = points.flatMap((p) => [p.unhedgedPnlCents, p.hedgePnlCents, p.netPnlCents]);
  const yTicks = ticks(Math.min(0, ...values), Math.max(0, ...values), 4);
  const yMin = Math.min(0, ...values, ...yTicks);
  const yMax = Math.max(0, ...values, ...yTicks);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (cents: number) => PAD.left + ((cents - xMin) / (xMax - xMin || 1)) * plotW;
  const y = (cents: number) => PAD.top + (1 - (cents - yMin) / (yMax - yMin || 1)) * plotH;
  const line = (pick: (point: PayoffPoint) => number) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.priceCents).toFixed(1)},${y(pick(p)).toFixed(1)}`)
      .join("");
  const xTicks = ticks(xMin, xMax, Math.max(2, Math.floor(plotW / 110)));

  const point = points[active] ?? first;
  const nearest = (clientX: number, left: number) => {
    const cents = xMin + ((clientX - left - PAD.left) / plotW) * (xMax - xMin);
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(p.priceCents - cents) < Math.abs((points[best]?.priceCents ?? 0) - cents)) best = i;
    });
    return best;
  };
  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    setActive(nearest(event.clientX, event.currentTarget.getBoundingClientRect().left));
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(points.length - 1);
    else if (step !== 0) setActive((current) => Math.min(points.length - 1, Math.max(0, current + step)));
    else return;
    event.preventDefault();
  };

  return (
    <div className={styles.chart}>
      <ul className={styles.legend} aria-hidden>
        <li data-series="unhedged">{asset} alone</li>
        <li data-series="hedge">Hedge alone</li>
        <li data-series="net">Combined</li>
      </ul>
      <p className={styles.readout} aria-live="polite" data-testid="payoff-readout">
        <span className={styles.readoutPrice}>
          If {asset} settles at {usd(point.priceCents)}:
        </span>{" "}
        <span>
          {asset} alone <strong className="num">{formatUsdCentsDelta(point.unhedgedPnlCents)}</strong>
        </span>
        <span>
          hedge <strong className="num">{formatUsdCentsDelta(point.hedgePnlCents)}</strong>
        </span>
        <span>
          combined <strong className="num">{formatUsdCentsDelta(point.netPnlCents)}</strong>
        </span>
      </p>
      <div ref={frame} className={styles.plot}>
        <svg
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${width.toString()} ${HEIGHT.toString()}`}
          role="img"
          aria-label={`Payoff at settlement for ${asset}, from ${usd(xMin)} to ${usd(xMax)}. Use the arrow keys to read each point.`}
          tabIndex={0}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onKeyDown={onKey}
          className={styles.svg}
        >
          {yTicks.map((tick) => (
            <g key={`y${tick.toString()}`}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? styles.zero : styles.grid}
              />
              <text x={PAD.left - 8} y={y(tick)} className={styles.axisY} dominantBaseline="middle">
                {formatUsdCentsDelta(tick).replace(".00", "")}
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={`x${tick.toString()}`} x={x(tick)} y={HEIGHT - 10} className={styles.axisX}>
              {priceTick(tick)}
            </text>
          ))}
          {strikesCents.map((strike) => (
            <line
              key={`k${strike.toString()}`}
              x1={x(strike)}
              x2={x(strike)}
              y1={PAD.top + plotH}
              y2={PAD.top + plotH + 5}
              className={styles.strikeTick}
            />
          ))}
          {spotCents >= xMin && spotCents <= xMax ? (
            <g>
              <line
                x1={x(spotCents)}
                x2={x(spotCents)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                className={styles.spot}
              />
              <text x={x(spotCents) + 4} y={PAD.top + 10} className={styles.spotLabel}>
                Spot
              </text>
            </g>
          ) : null}
          <path d={line((p) => p.unhedgedPnlCents)} className={styles.series} data-series="unhedged" />
          <path d={line((p) => p.hedgePnlCents)} className={styles.series} data-series="hedge" />
          <path d={line((p) => p.netPnlCents)} className={styles.series} data-series="net" />
          <line
            x1={x(point.priceCents)}
            x2={x(point.priceCents)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className={styles.cursor}
          />
          {(["unhedgedPnlCents", "hedgePnlCents", "netPnlCents"] as const).map((key) => (
            <circle
              key={key}
              cx={x(point.priceCents)}
              cy={y(point[key])}
              r={3.5}
              className={styles.dot}
              data-series={
                key === "unhedgedPnlCents" ? "unhedged" : key === "hedgePnlCents" ? "hedge" : "net"
              }
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
