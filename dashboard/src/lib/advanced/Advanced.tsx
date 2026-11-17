"use client";

import { createCookieStorage, createPreference } from "@ui-sdk/core";
import { Preferences, usePreference } from "@ui-sdk/react/preferences";
import { type ReactNode, createContext, use, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/Button";

import { ADVANCED_COOKIE } from "./cookie";
import styles from "./Advanced.module.css";

const VALUES = ["off", "on"] as const;

function createAdvanced(cookie: string | null) {
  return createPreference({
    values: VALUES,
    defaultValue: "off",
    attribute: "data-advanced",
    storage: createCookieStorage(ADVANCED_COOKIE, { cookie, sameSite: "lax" }),
  });
}

type AdvancedPreference = ReturnType<typeof createAdvanced>;

const AdvancedContext = createContext<AdvancedPreference | null>(null);

// Pages outside the console (the public scorecard) have no provider and always read as default.
const alwaysOff = createPreference({ values: VALUES, defaultValue: "off", attribute: "data-advanced" });

/**
 * The owner's "Advanced view" preference, kept in a cookie so the server renders the right variant.
 * Create it once per request from the cookie the server read, as ui-sdk's server rendering guide asks.
 */
export function AdvancedProvider({ cookie, children }: { cookie: string | null; children: ReactNode }) {
  const [preference] = useState(() => createAdvanced(cookie));
  return (
    <AdvancedContext value={preference}>
      <Preferences preferences={[preference]}>{children}</Preferences>
    </AdvancedContext>
  );
}

export interface AdvancedState {
  /** Whether hashes, raw symbols, block details and diagnostics show. Off by default. */
  advanced: boolean;
  setAdvanced: (on: boolean) => void;
}

export function useAdvanced(): AdvancedState {
  const preference = use(AdvancedContext) ?? alwaysOff;
  const { value } = usePreference(preference);
  return { advanced: value === "on", setAdvanced: (on) => preference.set(on ? "on" : "off") };
}

/** Detail for Advanced view only: hashes, full addresses, raw symbols, block numbers, reason codes. */
export function Advanced({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { advanced } = useAdvanced();
  return advanced ? children : fallback;
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The URL's fragment without "#", or "" on the server (which never sees it). */
export function useHash(): string {
  return useSyncExternalStore(
    subscribeHash,
    () => decodeURIComponent(window.location.hash.slice(1)),
    () => "",
  );
}

/**
 * A section only Advanced view shows. A link to its `id` still shows it in the default view, with a note
 * saying why, so a shared deep link never leads nowhere.
 */
export function AdvancedSection({ id, children }: { id: string; children: ReactNode }) {
  const { advanced, setAdvanced } = useAdvanced();
  const linked = useHash() === id;
  if (advanced) return <div id={id}>{children}</div>;
  if (!linked) return null;
  return (
    <div id={id} className={styles.linked}>
      <div className={styles.note} data-testid="advanced-note">
        <p>
          <strong>Shown because a link pointed here.</strong> This is part of Advanced view.
        </p>
        <Button variant="secondary" size="sm" onClick={() => setAdvanced(true)}>
          Turn on Advanced view
        </Button>
      </div>
      {children}
    </div>
  );
}
