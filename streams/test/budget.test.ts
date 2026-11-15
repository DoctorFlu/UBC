import { describe, expect, it } from "vitest";

import {
  BUILD_PLAN_MONTHLY_CREDITS,
  blocksPerDay,
  creditsBetween,
  creditsPerDay,
  estimateBackfill,
} from "../src/budget";

describe("Stream credit budget", () => {
  it("prices a logs Stream on Arc at 0.5 s blocks", () => {
    expect(blocksPerDay()).toBe(172_800);
    expect(creditsPerDay()).toBe(3_456_000);
  });

  it("prices the run from 2026-11-15 to 2026-11-22 well inside the Build allowance", () => {
    const credits = creditsBetween(new Date("2026-11-15T00:00:00Z"), new Date("2026-11-22T00:00:00Z"));
    expect(credits).toBe(24_192_000);
    expect(credits / BUILD_PLAN_MONTHLY_CREDITS).toBeCloseTo(0.3024, 4);
  });

  it("shows a nonstop 30-day Stream would exceed the Build allowance", () => {
    expect(creditsPerDay() * 30).toBe(103_680_000);
    expect(creditsPerDay() * 30).toBeGreaterThan(BUILD_PLAN_MONTHLY_CREDITS);
  });

  it("flags backfills from old blocks", () => {
    expect(estimateBackfill(100, 100)).toEqual({ blocks: 1, credits: 20, needsConfirmation: false });
    expect(estimateBackfill(1, 10_000)).toMatchObject({ blocks: 10_000, needsConfirmation: false });
    expect(estimateBackfill(1, 10_001)).toMatchObject({ credits: 200_020, needsConfirmation: true });
    expect(estimateBackfill(500, 100)).toEqual({ blocks: 0, credits: 0, needsConfirmation: false });
  });
});
