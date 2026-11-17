"use client";

/**
 * An inline script that runs while the browser parses the HTML, before first paint. The client renders
 * it as inert `text/plain`, since React never runs a script it inserts and warns about one; this is the
 * pattern from the Next.js guide "Preventing flash before hydration", as in the console.
 */
export function InlineScript({ id, html }: { id: string; html: string }) {
  return (
    <script
      id={id}
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
