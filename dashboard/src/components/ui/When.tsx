"use client";

import { useSyncExternalStore } from "react";

import { useAdvanced } from "@/lib/advanced/Advanced";
import { formatDateUtc, formatTimeUtc } from "@/lib/format";
import { exactUtc, relativeTime } from "@/lib/when";

const TICK_MS = 30_000;
let tickTimer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  tickTimer ??= setInterval(() => {
    for (const notify of listeners) notify();
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };
}

const currentTick = () => Math.floor(Date.now() / TICK_MS);
// The server and the first browser render know no clock or time zone: both show the exact UTC time,
// so hydration always matches, and the owner's own clock takes over right after.
const serverTick = () => null;

export interface WhenProps {
  /** Unix seconds, or an ISO string. */
  at: number | string;
  /** Include the date in the exact form, where the moment may be on another day. */
  date?: boolean;
  /** In the exact form, put the date on a second line with this class (for table cells). */
  dateClassName?: string;
  className?: string;
  /** After other words ("Saved just now"): starts in lower case, where a cell starts with a capital. */
  inSentence?: boolean;
}

/** "Today, 4:00 PM" reads "today, 4:00 PM" after other words; month names keep their capital. */
const SENTENCE_START = /^(Just now|Today|Yesterday|Tomorrow)/;

function toSentence(text: string): string {
  return SENTENCE_START.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/**
 * A moment as the owner reads it: "2 min ago" or "Today, 6:20 PM" on their own clock, with the exact UTC
 * time on hover and in the markup. Advanced view shows the exact UTC time itself.
 */
export function When({
  at,
  date: withDate = false,
  dateClassName,
  className,
  inSentence = false,
}: WhenProps) {
  const { advanced } = useAdvanced();
  const tick = useSyncExternalStore(subscribe, currentTick, serverTick);
  const date = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  const iso = date.toISOString();
  if (!advanced && tick !== null) {
    return (
      <time dateTime={iso} title={exactUtc(date)} className={className}>
        {inSentence
          ? toSentence(relativeTime(date, { now: new Date(tick * TICK_MS) }))
          : relativeTime(date, { now: new Date(tick * TICK_MS) })}
      </time>
    );
  }
  if (dateClassName) {
    return (
      <time dateTime={iso} title={exactUtc(date)} className={className}>
        <span>{formatTimeUtc(iso)}</span>
        <span className={dateClassName}>{formatDateUtc(iso)}</span>
      </time>
    );
  }
  return (
    <time dateTime={iso} title={exactUtc(date)} className={className}>
      {withDate ? `${formatDateUtc(iso)}, ${formatTimeUtc(iso)}` : formatTimeUtc(iso)}
    </time>
  );
}
