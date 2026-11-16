"use client";

import { KNOWN_ASSETS } from "@mandate/gemini";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { HedgeMarketResponse } from "@/lib/hedge/types";

/** How often an open hedge view asks the console for fresh quotes. The console caches Gemini for 10 s. */
export const QUOTES_REFRESH_MS = 15_000;

export type HedgeMarketState =
  | { status: "off" }
  /** Gemini lists no ladders for this asset, so the console does not ask. */
  | { status: "unsupported" }
  | { status: "loading" }
  /** The console did not answer (it is down or restarting); Gemini's own failures arrive in `data.error`. */
  | { status: "error"; message: string }
  | { status: "ready"; data: HedgeMarketResponse; updatedAt: number };

/**
 * Live quotes (and, with `preview`, a preview plan) for one asset, from the console's
 * GET /api/console/hedge/market. The browser never calls Gemini itself. A failed refresh keeps the last
 * answer on screen with its time, so a blip never blanks the ladder.
 */
export function useHedgeMarket(input: {
  asset: string;
  /** The stored plan's event; part of the cache key only, so a new plan asks again at once. */
  eventTicker: string | null;
  preview: boolean;
  /** Changes whenever the preview's inputs (holdings, rules, committed budget) change, to ask again at once. */
  inputsKey: string;
  enabled: boolean;
}): HedgeMarketState {
  const supported = (KNOWN_ASSETS as readonly string[]).includes(input.asset);
  const query = useQuery({
    queryKey: [
      "hedge-market",
      input.asset,
      input.eventTicker,
      input.preview,
      input.preview ? input.inputsKey : "",
    ],
    // Keep the last answer on screen while a new key loads, so a refresh never blanks the ladder.
    placeholderData: keepPreviousData,
    enabled: input.enabled && supported,
    refetchInterval: QUOTES_REFRESH_MS,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }): Promise<HedgeMarketResponse> => {
      const params = new URLSearchParams({ asset: input.asset });
      // No `event`: the console asks for the event of the plan it stores, and refuses any other.
      if (input.preview) params.set("preview", "1");
      const response = await fetch(`/api/console/hedge/market?${params.toString()}`, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`The console answered ${response.status.toString()}.`);
      return (await response.json()) as HedgeMarketResponse;
    },
  });
  if (!input.enabled) return { status: "off" };
  if (!supported) return { status: "unsupported" };
  if (query.data) return { status: "ready", data: query.data, updatedAt: query.dataUpdatedAt };
  if (query.isError) {
    return { status: "error", message: "The console did not answer. It tries again in a few seconds." };
  }
  return { status: "loading" };
}
