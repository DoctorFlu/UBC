import localFont from "next/font/local";

// Self-hosted variable fonts (SIL Open Font License, see the *-OFL.txt files beside them), so
// builds need no network and next/font generates size-adjusted fallbacks: no layout shift.
//
// next/font resolves `src` relative to this file and needs a literal string, so these paths
// point at ./fonts here; every app that imports this module gets the same two families.

/** Mona Sans: weight 200 to 900 and width 75% to 125%. The console uses the width axis. */
export const monaSans = localFont({
  src: "./fonts/MonaSans-Variable.woff2",
  variable: "--font-mona",
  weight: "200 900",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "75% 125%" }],
});

/** Martian Mono: only for hashes, addresses and reason codes. */
export const martianMono = localFont({
  src: "./fonts/MartianMono-Variable.woff2",
  variable: "--font-martian",
  weight: "100 800",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "75% 112.5%" }],
});
