"use client";

import { createContext, type ReactNode, useCallback, useContext } from "react";

import type { MandateView } from "@/lib/accounts/types";
import { mandatePath, withMandate } from "@/lib/mandate-path";

export interface MandateScope {
  /** The mandate this page shows. */
  mandate: MandateView;
  /** Every mandate of the workspace, for the switcher. */
  mandates: readonly MandateView[];
  /** Who deploys a mandate's contract here: the console (demo chain) or the owner's wallet (Arc). */
  deployer: "server" | "wallet" | null;
  /** Whether the member may change things (an admin), or only look (a viewer). */
  canAct: boolean;
}

const MandateContext = createContext<MandateScope | null>(null);

export function MandateProvider({ value, children }: { value: MandateScope; children: ReactNode }) {
  return <MandateContext.Provider value={value}>{children}</MandateContext.Provider>;
}

/** The page's mandate, or null outside one (the workspace pages, the component gallery). */
export function useMandateScope(): MandateScope | null {
  return useContext(MandateContext);
}

/**
 * Links and API URLs for the page's mandate: `href("/approvals")` is `/m/<id>/approvals`, and `api(url)`
 * names the mandate with `?mandate=`. Outside a mandate both return what they are given.
 */
export function useMandateUrls(): { href: (path: string) => string; api: (url: string) => string } {
  const id = useContext(MandateContext)?.mandate.id ?? null;
  const href = useCallback((path: string) => (id === null ? path : mandatePath(id, path)), [id]);
  const api = useCallback((url: string) => (id === null ? url : withMandate(url, id)), [id]);
  return { href, api };
}
