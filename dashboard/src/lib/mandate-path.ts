/**
 * Where one mandate's pages live (#95): `/m/<mandate id>/...`, so the URL always says which mandate a page
 * shows and a link opens the same mandate for anyone in the workspace. Ids are `mnd_` and base32, so they
 * need no escaping, but they are escaped anyway in case that ever changes.
 */
export const MANDATE_PATH_PREFIX = "/m/";

/** The views that live under a mandate, by their first path segment. */
export const MANDATE_VIEWS = [
  "approvals",
  "activity",
  "rules",
  "hedge",
  "payments",
  "audit",
  "setup",
] as const;

/** `/m/<id>` plus `path` (which starts with `/`, or is empty for the mandate's home). */
export function mandatePath(mandateId: string, path = ""): string {
  if (path !== "" && !path.startsWith("/")) throw new Error(`a mandate path starts with "/", got "${path}"`);
  const base = `${MANDATE_PATH_PREFIX}${encodeURIComponent(mandateId)}`;
  return path === "/" ? base : `${base}${path}`;
}

/** The view path inside a mandate (`/approvals`, or `/` for its home), or null outside one. */
export function viewPathOf(pathname: string): { mandateId: string; path: string } | null {
  if (!pathname.startsWith(MANDATE_PATH_PREFIX)) return null;
  const rest = pathname.slice(MANDATE_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  if (id === "") return null;
  return { mandateId: id, path: slash === -1 ? "/" : rest.slice(slash) || "/" };
}

/** An API URL naming the mandate it acts on (`?mandate=`), which every write to a mandate route must. */
export function withMandate(url: string, mandateId: string): string {
  const [path = "", hash] = url.split("#", 2);
  const separator = path.includes("?") ? "&" : "?";
  const named = `${path}${separator}mandate=${encodeURIComponent(mandateId)}`;
  return hash === undefined ? named : `${named}#${hash}`;
}
