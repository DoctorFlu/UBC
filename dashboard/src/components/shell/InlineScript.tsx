"use client";

/**
 * An inline script that runs while the browser parses the server's HTML, before first paint.
 *
 * React warns whenever it renders a `<script>` on the client (it never runs scripts it inserts), which
 * happens when a page such as a 404 is rendered in the browser. So the client renders it as inert
 * `text/plain`, and `suppressHydrationWarning` accepts the server's type on hydration. This is the
 * pattern from the Next.js guide "Preventing flash before hydration".
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
