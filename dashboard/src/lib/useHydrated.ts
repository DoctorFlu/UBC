import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * False in the server HTML and until React hydrates, true after. A submit button pressed before
 * hydration falls back to the browser's native GET submit, which reloads the page and loses the draft,
 * so forms keep their submit disabled until this is true.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
