"use client";

import { useEffect, useSyncExternalStore } from "react";

/*
 * Next hydrates the console shell first and each page's own Suspense boundary after it. A modal that
 * opens in between (the phone menu) makes the page inert, and ui-sdk keeps live regions inside the page
 * usable by marking their siblings inert one level at a time, so it writes attributes into markup React
 * has not hydrated yet, and React reports a mismatch. The page says when it has hydrated, and every
 * modal (components/ui/Dialog) waits for that before it opens: a tap that comes too early is kept, so
 * the modal opens a moment later instead of throwing.
 */
let hydrated = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePageHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hydrated,
    () => false,
  );
}

/** Rendered once inside every page (by PageHeader); its effect runs after the page's boundary hydrates. */
export function PageHydrationBeacon() {
  useEffect(() => {
    if (hydrated) return;
    hydrated = true;
    document.documentElement.dataset.pageHydrated = "";
    for (const notify of listeners) notify();
  }, []);
  return null;
}
