import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { InlineScript } from "../components/InlineScript";
import { SITE_URL } from "../config";
import { themeBootScript } from "../lib/theme";

import { martianMono, monaSans } from "@mandate/brand/fonts";
import "./globals.css";

const title = "Mandate: your agent trades, you hold the breaker";
const description =
  "Put your AI trading agent behind rules in a contract. Every order it proposes is approved, held for your signature, or rejected before it can trade.";

// The icons (favicon.ico, icon.svg, apple-icon.png) and the preview image (opengraph-image.png,
// twitter-image.png) are files in this folder, which Next declares itself. metadataBase makes the
// preview URLs absolute, as link previews need.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  applicationName: "Mandate",
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: "Mandate", url: "/", title, description, locale: "en" },
  twitter: { card: "summary_large_image", title, description },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e9ebe8" },
    { media: "(prefers-color-scheme: dark)", color: "#22282b" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The boot script sets data-theme before paint when the visitor pinned a theme.
    <html lang="en" className={`${monaSans.variable} ${martianMono.variable}`} suppressHydrationWarning>
      <head>
        <InlineScript id="theme-boot" html={themeBootScript} />
      </head>
      <body>{children}</body>
    </html>
  );
}
