import { martianMono, monaSans } from "@mandate/brand/fonts";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { InlineScript } from "@/components/shell/InlineScript";
import { ToastProvider } from "@/components/ui/Toast";
import { themeBootScript } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Mandate", template: "%s - Mandate" },
  description: "Set the rules your trading agent runs under, watch every intent, and stop it in one action.",
  applicationName: "Mandate",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#dde1dc" },
    { media: "(prefers-color-scheme: dark)", color: "#1c2124" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme is set before paint by the boot script when the owner pinned a theme, so the
    // server and client attributes can differ on purpose; that is the only suppressed mismatch.
    <html lang="en" className={`${monaSans.variable} ${martianMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Runs before first paint. Not next/script: with inline children it makes React render a
            <script> on the client, which React never executes and warns about. */}
        <InlineScript id="theme-boot" html={themeBootScript} />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
