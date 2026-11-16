"use client";

import { useState } from "react";

/**
 * A tab choice kept in the address (`?<key>=<tab>`), so a reload or a shared link opens the same tab.
 * The server reads the parameter and passes the first tab in; switching replaces the history entry
 * rather than adding one, and the parameter is left out for the page's default tab.
 */
export function useQueryTab<Tab extends string>(
  key: string,
  initial: Tab,
  fallback: Tab,
): [Tab, (next: Tab) => void] {
  const [tab, setTab] = useState<Tab>(initial);
  const select = (next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, next);
    window.history.replaceState(window.history.state, "", url);
  };
  return [tab, select];
}
