"use client";

import { Button } from "@ui-sdk/react/button";

import { THEME_STORAGE_KEY, type ThemePreference } from "../lib/theme";

import styles from "./chrome.module.css";

function systemScheme(): ThemePreference {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * The console's two-state theme switch: it always flips what you see, and flipping back to the system's
 * scheme forgets the choice. Both labels are in the markup and CSS shows the one that applies.
 */
export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const pinned = root.dataset.theme;
    const rendered: ThemePreference = pinned === "light" || pinned === "dark" ? pinned : systemScheme();
    const target: ThemePreference = rendered === "dark" ? "light" : "dark";

    root.classList.add("theme-switching");
    try {
      if (target === systemScheme()) localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, target);
    } catch {
      // Storage can be blocked; the theme still applies for this page.
    }
    if (target === systemScheme()) delete root.dataset.theme;
    else root.dataset.theme = target;
    root.getBoundingClientRect();
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  };

  return (
    <Button className={styles.themeToggle} onClick={toggle}>
      <span className={styles.toDark}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
        </svg>
        Use dark theme
      </span>
      <span className={styles.toLight}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
        Use light theme
      </span>
    </Button>
  );
}
