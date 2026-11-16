/** Text an agent wrote, made safe to show beside the owner's controls. Pure, so it is unit tested. */

/** About three lines of a narrow card; a longer reason shows this much until the owner asks for the rest. */
export const PREVIEW_CHARACTERS = 160;

/**
 * Agent-written text as one plain run of words: control characters (newlines, tabs), line and paragraph
 * separators, and bidirectional overrides become spaces, and runs of space collapse. The agent chooses this
 * text, so it must not be able to fake a second paragraph or a heading, or reorder what it says.
 */
export function oneBlock(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The first `PREVIEW_CHARACTERS` characters, cut at a word boundary when one is near, with an ellipsis. */
export function reasonPreview(text: string): string {
  const head = Array.from(text).slice(0, PREVIEW_CHARACTERS).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > PREVIEW_CHARACTERS * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}
