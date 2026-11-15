/**
 * Theme preference. No stored value means "follow the system"; a stored "light" or "dark" pins
 * the scheme. The stored value is mirrored to `<html data-theme>`, which tokens.css maps to
 * `color-scheme`, so every light-dark() token follows it.
 */
export type ThemePreference = "light" | "dark";

export const THEME_STORAGE_KEY = "mandate-theme";

/**
 * Runs inline in <head> before first paint, so a pinned theme never flashes the other one.
 * Kept tiny and dependency-free on purpose.
 */
export const themeBootScript = `try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
