"use client";

import { RefreshCw } from "lucide-react";

import { MarketName } from "@/components/domain/Intent";
import { Skeleton } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import type { LadderQuotes, QuoteRung } from "@/lib/hedge/types";
import { formatContractPrice, formatContractsHundredths, formatTimeUtc, formatUsdCents } from "@/lib/format";

import styles from "./hedge.module.css";
import type { HedgeMarketState } from "./useHedgeMarket";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });
const price = (cents: number | null) => (cents === null ? "None" : formatContractPrice(cents));

interface LadderRow extends QuoteRung {
  /** Hundredths of a contract the plan buys on this rung, or 0. */
  boughtHundredths: number;
}

function columns(asset: string, planLabel: string): readonly Column<LadderRow>[] {
  return [
    {
      key: "strike",
      header: `Pays if ${asset} ends below`,
      cell: (row) => <span className="num">{usd(row.strikeCents)}</span>,
      nowrap: true,
    },
    {
      key: "market",
      header: "Market",
      cell: (row) => <MarketName symbol={row.instrumentSymbol} />,
      role: "primary",
    },
    {
      key: "no",
      header: "NO ask",
      cell: (row) => <span className="num">{price(row.noBuyCents)}</span>,
      align: "end",
      nowrap: true,
    },
    {
      key: "yes",
      header: "YES bid / ask",
      cell: (row) => (
        <span className="num">
          {price(row.yesBidCents)} / {price(row.yesAskCents)}
        </span>
      ),
      align: "end",
      nowrap: true,
    },
    {
      key: "bought",
      header: planLabel,
      cell: (row) =>
        row.boughtHundredths > 0 ? (
          <span className={styles.bought} data-testid="bought-rung">
            <span className="num">{formatContractsHundredths(row.boughtHundredths)}</span> NO
          </span>
        ) : (
          <span className={styles.notBought}>
            <span className="visually-hidden">Not bought</span>
            <span aria-hidden>-</span>
          </span>
        ),
      align: "end",
      nowrap: true,
    },
  ];
}

const SKELETON_ROWS = 6;

/**
 * Gemini's live quotes for the ladder a plan is on, with the rungs the plan buys marked. Quotes come
 * from the console (which caches Gemini), refresh on their own, and a failure keeps the plan readable.
 */
export function LiveLadder({
  asset,
  market,
  bought,
  planLabel,
}: {
  asset: string;
  market: HedgeMarketState;
  /** Hundredths bought per instrument symbol by the plan shown. */
  bought: ReadonlyMap<string, number>;
  planLabel: string;
}) {
  if (market.status === "off") {
    return <p className={styles.ladderNote}>Live quotes are not loaded in a preview of this page.</p>;
  }
  if (market.status === "loading") {
    return (
      <div className={styles.ladderLoading} aria-busy="true" aria-label="Loading live quotes">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} height="1.25rem" />
        ))}
      </div>
    );
  }
  if (market.status === "error") {
    return (
      <p className={styles.ladderNote} role="status" data-testid="quotes-error">
        <RefreshCw aria-hidden /> {market.message}
      </p>
    );
  }
  const { quotes, error } = market.data;
  if (!quotes) {
    return (
      <p className={styles.ladderNote} role="status" data-testid="quotes-error">
        <RefreshCw aria-hidden /> {error?.message ?? "Gemini's quotes are not available."} The plan above does
        not depend on them.
      </p>
    );
  }
  const rows: LadderRow[] = quotes.rungs.map((rung) => ({
    ...rung,
    boughtHundredths: bought.get(rung.instrumentSymbol) ?? 0,
  }));
  return (
    <div className={styles.ladder} data-testid="live-ladder" data-event={quotes.eventTicker}>
      <Table
        caption={`Live quotes for ${quotes.title}, highest strike first`}
        captionHidden
        columns={columns(asset, planLabel)}
        rows={rows}
        rowKey={(row) => row.instrumentSymbol}
        rowTone={(row) => (row.boughtHundredths > 0 ? "attention" : undefined)}
      />
    </div>
  );
}

/** "BTC price on November 20, spot $65,586, quoted 20:19:04 UTC", or why there is nothing to quote. */
export function ladderCaption(quotes: LadderQuotes | null): string | null {
  if (!quotes) return null;
  return `${quotes.title}. Spot ${usd(quotes.spotCents)}, quoted ${formatTimeUtc(quotes.fetchedAt)}.`;
}
