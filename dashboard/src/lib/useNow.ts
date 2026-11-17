"use client";

import { useSyncExternalStore } from "react";

/** How often a mounted clock moves on: the console shows times to the minute. */
export const NOW_TICK_MS = 30_000;

let tickTimer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  tickTimer ??= setInterval(() => {
    for (const notify of listeners) notify();
  }, NOW_TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };
}

const currentTick = () => Math.floor(Date.now() / NOW_TICK_MS);
const serverTick = () => null;

/**
 * The owner's clock in milliseconds, moving every 30 seconds, shared by every component that reads it.
 * Null in the server HTML and the first browser render, which know no clock: a caller shows the version
 * that does not depend on the time until the browser's clock takes over, so hydration always matches.
 */
export function useNow(): number | null {
  const tick = useSyncExternalStore(subscribe, currentTick, serverTick);
  return tick === null ? null : tick * NOW_TICK_MS;
}
