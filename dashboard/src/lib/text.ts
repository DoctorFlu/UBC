/**
 * Strings from the chain or the agent are untrusted: a market symbol can be 16 KiB. Views clip them to
 * a readable length before drawing them, and offer the full value through a copy button where it matters.
 */

/** At most `max` characters of `text`, ending in "…" when cut, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max - 1);
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}
