/**
 * The console's theme behaviour, on this origin: no stored value follows the system; a stored "light"
 * or "dark" pins the scheme through `<html data-theme>`, which the brand tokens map to `color-scheme`.
 */
export type ThemePreference = "light" | "dark";

export const THEME_STORAGE_KEY = "mandate-theme";

/** Runs inline in <head> before first paint, so a pinned theme never flashes the other one. */
export const themeBootScript = `try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
