import type { MandateSummary } from "./types";

type Cover = Pick<MandateSummary["cover"], "goals" | "met" | "unavailable">;

/** Every mandate's goals, added up for Home's headline. */
export function totalCover(mandates: readonly Pick<MandateSummary, "cover">[]): Cover {
  return mandates.reduce(
    (sum, row) => ({
      goals: sum.goals + row.cover.goals,
      met: sum.met + row.cover.met,
      unavailable: sum.unavailable + row.cover.unavailable,
    }),
    { goals: 0, met: 0, unavailable: 0 },
  );
}

/** One mandate's cover on its Home row. */
export function coverText(cover: Cover): { value: string; hint: string } {
  if (cover.goals === 0) return { value: "No goals", hint: "No current hedge goal" };
  if (cover.unavailable === cover.goals) return { value: "Unknown", hint: "Can't measure it right now" };
  return {
    value: `${String(cover.met)} of ${String(cover.goals)}`,
    hint:
      cover.unavailable > 0
        ? `goals covered; ${String(cover.unavailable)} can't be measured now`
        : cover.goals === 1
          ? "goal covered"
          : "goals covered",
  };
}

/**
 * The headline across every mandate, by the same rule as each row: a goal whose cover cannot be measured
 * (Gemini's quotes unavailable) is never counted as not covered.
 */
export function goalsCoveredText(cover: Cover): { value: string; hint?: string } {
  if (cover.goals === 0) return { value: "None set" };
  if (cover.unavailable === cover.goals) return { value: "Unknown", hint: "Can't measure it right now" };
  const value = `${String(cover.met)} of ${String(cover.goals)}`;
  return cover.unavailable > 0
    ? { value, hint: `${String(cover.unavailable)} can't be measured now` }
    : { value };
}
