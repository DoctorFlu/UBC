"use client";

import { useAdvanced } from "@/lib/advanced/Advanced";
import { formatDateUtc, formatTimeUtc } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { exactUtc, relativeTime } from "@/lib/when";

// The server and the first browser render know no clock or time zone: both show the exact UTC time,
// so hydration always matches, and the owner's own clock takes over right after.

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
  const now = useNow();
  const date = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  const iso = date.toISOString();
  if (!advanced && now !== null) {
    return (
      <time dateTime={iso} title={exactUtc(date)} className={className}>
        {inSentence
          ? toSentence(relativeTime(date, { now: new Date(now) }))
          : relativeTime(date, { now: new Date(now) })}
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
