"use client";

import { Moon, Sun } from "lucide-react";

import { THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

import styles from "./ThemeToggle.module.css";

function systemScheme(): ThemePreference {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Two-state theme switch: it always flips what you see. Flipping back to the system's scheme
 * clears the stored choice, so the console follows the system again. Both labels are in the
 * markup and CSS shows the one that applies, so it needs no client state and never mismatches.
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
    // Force a style flush, then restore transitions on the next frame.
    root.getBoundingClientRect();
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  };

  return (
    <button type="button" className={styles.toggle} onClick={toggle}>
      <span className={styles.toDark}>
        <Moon aria-hidden strokeWidth={1.75} />
        Use dark theme
      </span>
      <span className={styles.toLight}>
        <Sun aria-hidden strokeWidth={1.75} />
        Use light theme
      </span>
    </button>
  );
}
