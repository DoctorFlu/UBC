"use client";

import {
  INTENT_STATUS_LABELS,
  type IntentStatus,
  type IntentView,
  type Settlement,
  settlementTotals,
} from "@mandate/shared";
import { Inbox } from "lucide-react";
import { useEffect, useState } from "react";

import { ApprovalActions } from "@/components/domain/ApprovalActions";
import { IntentLink, IntentVerdict, MarketName, OrderAmount } from "@/components/domain/Intent";
import { FillSharesTag } from "@/components/domain/FillSourceTag";
import { ChainUnavailable } from "@/components/states/ChainStates";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { type TabItem, Tabs } from "@/components/ui/Tabs";
import { When } from "@/components/ui/When";
import { formatCount, formatUsdCents } from "@/lib/format";
import { useAdvanced } from "@/lib/advanced/Advanced";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { agentName, countByStatus, newestFirst, todayUsage } from "@/lib/live/derive";
import type { ConsoleSnapshot, VenueOrderView } from "@/lib/live/types";
import { fillShares, filledIntentIds } from "@/lib/network";
import { verifiedSettlements } from "@/lib/settlement/settlement";

import styles from "./activity.module.css";

/**
 * What a filled position paid when its market resolved and its net, after Gemini's estimated fee when it
 * paid one (the page's totals say once that fees are estimated); empty until it settles.
 */
function SettledCell({ settlement }: { settlement: Settlement | undefined }) {
  if (!settlement) return null;
  return (
    <span className={styles.settled} data-testid="intent-settled">
      {/* One line: in the column below, bare text and the amount would each take a line of their own. */}
      <span>
        {settlement.payoutCents > 0 ? (
          <>
            Paid <Money cents={settlement.payoutCents} />
          </>
        ) : (
          "Paid nothing"
        )}
      </span>
      <span className={styles.net}>
        Net <Money cents={settlement.pnlCents} sign="always" />
      </span>
    </span>
  );
}

/** The intent's number, linking to its page, and when it was proposed, under it. */
function IntentCell({ intent }: { intent: IntentView }) {
  return (
    <span className={styles.intentCell}>
      <IntentLink id={intent.id} />
      <When at={intent.proposedAt} className={styles.when} />
    </span>
  );
}

/**
 * The contract's verdict. In Advanced view the transaction that proposed the intent (and so carried the
 * verdict) follows it, linked to the explorer. A held intent, in a tab without the Decision column, has a
 * "Decide" button that opens Waiting on its row.
 */
function VerdictCell({
  intent,
  advanced,
  decide,
}: {
  intent: IntentView;
  advanced: boolean;
  decide: ((id: number) => void) | null;
}) {
  return (
    <span className={styles.verdictCell}>
      <span className={styles.verdictLine}>
        <IntentVerdict intent={intent} />
        {decide && intent.status === "needs_approval" ? (
          <button
            type="button"
            className={styles.decide}
            onClick={() => decide(intent.id)}
            aria-label={`Decide on intent #${intent.id.toString()} in Waiting`}
            data-testid="decide"
          >
            Decide
          </button>
        ) : null}
      </span>
      {advanced ? (
        <HexValue value={intent.proposedTxHash} kind="tx" copy={false} className={styles.proposal} />
      ) : null}
    </span>
  );
}

interface ColumnsOptions {
  settlements: ReadonlyMap<number, Settlement>;
  venueOrders: Readonly<Record<number, VenueOrderView>>;
  advanced: boolean;
  /** The statuses a tab lists: its columns are the ones those intents can fill. */
  statuses: readonly IntentStatus[];
  decide: (id: number) => void;
}

/**
 * A tab's columns, the same at every width so a laptop card holds them all: Intent (with its time),
 * Market, Order, Verdict (with the proposal in Advanced view), then At expiry where filled intents can be
 * and Decision only in Waiting. Elsewhere a held intent's verdict offers "Decide", which opens Waiting.
 */
function activityColumns({
  settlements,
  venueOrders,
  advanced,
  statuses,
  decide,
}: ColumnsOptions): Column<IntentView>[] {
  const decides = statuses.every((status) => status === "needs_approval");
  const columns: Column<IntentView>[] = [
    { key: "id", header: "Intent", cell: (intent) => <IntentCell intent={intent} />, nowrap: true },
    {
      key: "market",
      header: "Market",
      cell: (intent) => (
        <MarketName symbol={intent.market} category={intent.category} listing={intent.listing} />
      ),
      role: "primary",
    },
    {
      key: "order",
      header: "Order",
      // Not nowrap: an order the MCP server could not have sent reads longer, and wraps rather than widening.
      cell: (intent) => (
        <OrderAmount intent={intent} placedHundredths={venueOrders[intent.id]?.quantityHundredths ?? null} />
      ),
      align: "end",
    },
    {
      key: "verdict",
      header: "Verdict",
      cell: (intent) => <VerdictCell intent={intent} advanced={advanced} decide={decides ? null : decide} />,
    },
  ];
  if (statuses.includes("executed")) {
    columns.push({
      key: "settled",
      header: "At expiry",
      cell: (intent) => <SettledCell settlement={settlements.get(intent.id)} />,
      align: "end",
      nowrap: true,
    });
  }
  if (decides) {
    columns.push({
      key: "actions",
      header: "Decision",
      cell: (intent) => (intent.status === "needs_approval" ? <ApprovalActions intent={intent} /> : null),
      role: "actions",
      nowrap: true,
    });
  }
  return columns;
}

interface Filter {
  id: string;
  label: string;
  statuses: readonly IntentStatus[];
  empty: string;
}

const filters: readonly Filter[] = [
  {
    id: "all",
    label: "All",
    statuses: ["none", "approved", "needs_approval", "rejected", "executed", "failed"],
    empty: "No intents yet",
  },
  {
    id: "waiting",
    label: "Waiting",
    statuses: ["needs_approval"],
    empty: "Nothing needs your approval",
  },
  {
    id: "approved",
    label: INTENT_STATUS_LABELS.approved,
    statuses: ["approved"],
    empty: "Nothing waiting to fill",
  },
  {
    id: "executed",
    label: INTENT_STATUS_LABELS.executed,
    statuses: ["executed"],
    empty: "Nothing filled yet",
  },
  { id: "failed", label: INTENT_STATUS_LABELS.failed, statuses: ["failed"], empty: "No failed orders" },
  { id: "rejected", label: INTENT_STATUS_LABELS.rejected, statuses: ["rejected"], empty: "No rejections" },
];

/** Every intent, live, with the contract's verdict, filters by status, and approve or reject for the waiting ones. */
export function ActivityView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const chain = snapshot.chain;
  const settlements = verifiedSettlements(chain);
  if (!chain) return <ChainUnavailable snapshot={snapshot} title="Activity" />;
  const settled = settlementTotals([...settlements.values()]);

  const intents = newestFirst(chain);
  const usage = todayUsage(chain);
  const waiting = countByStatus(intents, ["needs_approval"]);
  const filledCents = intents.reduce(
    (sum, intent) => sum + (intent.status === "executed" ? (intent.filledCents ?? 0) : 0),
    0,
  );
  const executed = countByStatus(intents, ["executed"]);

  return (
    <div className={styles.view}>
      <PageHeader
        title="Activity"
        description={`Every intent ${agentName(snapshot, true)} sent, what the Policy contract decided, and what still needs your approval.`}
      />

      <StatGroup className={styles.stats}>
        <Stat
          label="Intents today"
          value={formatCount(usage.intents)}
          hint={`${formatCount(intents.length)} in all`}
        />
        <Stat
          label="Blocked today"
          value={formatCount(usage.blocked)}
          hint={`${formatCount(countByStatus(intents, ["rejected"]))} rejected in all`}
        />
        <Stat
          label="Filled"
          value={formatUsdCents(filledCents)}
          hint={
            <span className={styles.statHint}>
              {`${formatCount(executed)} ${executed === 1 ? "fill" : "fills"} recorded`}
              <FillSharesTag shares={fillShares(chain, snapshot.network, filledIntentIds(chain))} />
            </span>
          }
        />
        <Stat
          label="Paid at expiry"
          value={formatUsdCents(settled.payoutCents)}
          hint={
            settled.positions === 0 ? (
              "Nothing has settled yet"
            ) : (
              <span className={styles.statHint}>
                {`${formatCount(settled.positions)} settled, cost ${formatUsdCents(settled.costCents)}, ` +
                  (settled.feesEstimated ? `fees ${formatUsdCents(settled.feeCents)}, ` : "") +
                  `net ${formatUsdCents(settled.pnlCents, { sign: "always" })}` +
                  (settled.feesEstimated ? " (fees estimated)" : "")}
                <FillSharesTag shares={fillShares(chain, snapshot.network, settlements.keys())} />
              </span>
            )
          }
        />
      </StatGroup>

      <Card padding="flush">
        <ActivityTabs
          intents={intents}
          settlements={settlements}
          venueOrders={chain.venueOrders}
          initialTab={waiting > 0 ? "waiting" : "all"}
        />
      </Card>
    </div>
  );
}

/**
 * The status tabs. They open on Waiting when something is held, chosen once, when the view first has the
 * chain. "Decide" on a held intent in another tab opens Waiting with focus on that intent's Approve.
 */
function ActivityTabs({
  intents,
  settlements,
  venueOrders,
  initialTab,
}: {
  intents: readonly IntentView[];
  settlements: ReadonlyMap<number, Settlement>;
  venueOrders: Readonly<Record<number, VenueOrderView>>;
  initialTab: string;
}) {
  const { advanced } = useAdvanced();
  const [selected, setSelected] = useState(initialTab);
  // Each press of "Decide" is its own request (an object), so focus moves once per press, after Waiting
  // has rendered the row, and never again when the owner later picks Waiting themselves.
  const [focusRequest, setFocusRequest] = useState<{ id: number } | null>(null);

  useEffect(() => {
    if (focusRequest === null) return;
    const row = document.getElementById(waitingRowId(focusRequest.id));
    row?.querySelector<HTMLButtonElement>('button[aria-label^="Approve "]')?.focus();
    row?.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);

  const decide = (id: number) => {
    setSelected("waiting");
    setFocusRequest({ id });
  };

  const tabs: TabItem[] = filters.map((filter) => {
    const rows = intents.filter((intent) => filter.statuses.includes(intent.status));
    return {
      id: filter.id,
      label: filter.label,
      count: rows.length,
      content: (
        <Table
          caption={`${filter.label} intents`}
          captionHidden
          columns={activityColumns({ settlements, venueOrders, advanced, statuses: filter.statuses, decide })}
          rows={rows}
          rowKey={(intent) => intent.id.toString()}
          rowId={filter.id === "waiting" ? (intent) => waitingRowId(intent.id) : undefined}
          rowTone={(intent) => (intent.status === "needs_approval" ? "attention" : undefined)}
          empty={
            <EmptyState plain icon={<Inbox strokeWidth={1.75} />} title={filter.empty}>
              {filter.id === "all"
                ? "Intents appear here the moment the Policy contract decides them, without a refresh."
                : "Intents in this state appear here as they land onchain."}
            </EmptyState>
          }
        />
      ),
    };
  });

  return (
    <Tabs label="Filter intents by status" tabs={tabs} selected={selected} onSelect={setSelected} inset />
  );
}

function waitingRowId(id: number): string {
  return `waiting-intent-${id.toString()}`;
}
