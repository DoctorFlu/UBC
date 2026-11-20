import { type NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAMES } from "@/lib/accounts/cookies";

/**
 * Sends a browser with no session cookie to the sign-in page, remembering where it was going. Only a
 * shortcut: every console page and route checks the session itself (src/server/page-access.ts and
 * src/server/http/session.ts), so a cookie that is present but dead still gets nothing.
 */
export function proxy(request: NextRequest) {
  if (SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) return NextResponse.next();
  const url = request.nextUrl.clone();
  const next = `${url.pathname}${url.search}`;
  url.pathname = "/sign-in";
  url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url, 303);
}

export const config = {
  // Console pages only: not the API (each route answers 401 itself), the account pages, the public
  // public dashboard, the component gallery, Next's own files or the icons.
  matcher: [
    "/((?!api/|_next/|sign-in|sign-up|claim|recover|agent/|dev/|favicon.ico|icon.svg|apple-icon.png).*)",
  ],
};
