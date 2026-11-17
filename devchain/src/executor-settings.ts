/**
 * The simulated executor's settings from the environment.
 *
 * SIM_EXECUTOR_DELAY_MS   how long it waits after an approval before recording the fill (default 1500)
 * SIM_EXECUTOR_POLL_MS    how often it asks the chain for new approvals (default 1000, the watcher's own
 *                         default, which suits a laptop). A hosted demo sets it higher so the machine can go
 *                         quiet between visits.
 */
export interface ExecutorSettings {
  fillDelayMs: number;
  pollingIntervalMs: number | undefined;
}

function wholeMs(name: string, raw: string | undefined, min: number): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(
      `${name} must be a whole number of milliseconds, at least ${String(min)}, got "${value}"`,
    );
  }
  return parsed;
}

export function executorSettings(env: Record<string, string | undefined>): ExecutorSettings {
  return {
    fillDelayMs: wholeMs("SIM_EXECUTOR_DELAY_MS", env.SIM_EXECUTOR_DELAY_MS, 0) ?? 1_500,
    pollingIntervalMs: wholeMs("SIM_EXECUTOR_POLL_MS", env.SIM_EXECUTOR_POLL_MS, 50),
  };
}
