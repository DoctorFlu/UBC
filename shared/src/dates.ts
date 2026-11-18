/**
 * Dates as an agent repeats them to its owner. A model that works a weekday out of an ISO time can get it
 * wrong ("settles Thu Nov 20" for a Friday), so every text an agent reads a date from gives it whole,
 * weekday included, for the agent to copy.
 */

/** Gemini's markets, and the owners they serve, keep US Eastern time. */
const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * "Fri Nov 20, 2026, 5:00 PM ET" for 2026-11-20T22:00:00Z: weekday, date and time in US Eastern time,
 * whatever the host's locale and zone. Built from the parts, so the text is the same on every ICU version
 * (newer ones put a narrow no-break space before "PM"). Text that is not a date comes back as is.
 */
export function formatEasternTime(when: string | Date): string {
  const date = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(date.getTime())) return String(when);
  const parts = EASTERN.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("weekday")} ${part("month")} ${part("day")}, ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()} ET`;
}
