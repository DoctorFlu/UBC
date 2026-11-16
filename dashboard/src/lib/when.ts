/**
 * How a moment reads to the owner: relative while it is recent, then the day and time on their own clock.
 * Pure, so the browser and the tests format the same way; `timeZone` and `locale` default to the owner's.
 */
export interface WhenOptions {
  now: Date;
  timeZone?: string | undefined;
  locale?: string | undefined;
}

const MINUTE = 60_000;

function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    date,
  );
}

export function relativeTime(date: Date, { now, timeZone, locale }: WhenOptions): string {
  const ago = now.getTime() - date.getTime();
  // The clock ticks every 30 seconds, so a moment up to a minute "ahead" of it is still just now.
  if (ago > -MINUTE && ago < MINUTE) return "Just now";
  if (ago >= MINUTE && ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE).toString()} min ago`;

  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
  const day = dayKey(date, timeZone);
  if (day === dayKey(now, timeZone)) return `Today, ${clock}`;
  if (day === dayKey(new Date(now.getTime() - 24 * 60 * MINUTE), timeZone)) return `Yesterday, ${clock}`;

  const sameYear =
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(date) ===
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(now);
  const dayLabel = new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
  return `${dayLabel}, ${clock}`;
}

const exactFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** The exact moment, in UTC, as the audit trail and block timestamps give it: "16 Nov 2026, 23:20:47 UTC". */
export function exactUtc(date: Date): string {
  return `${exactFormatter.format(date)} UTC`;
}
