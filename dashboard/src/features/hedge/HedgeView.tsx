"use client";

import type { HedgePlan } from "@mandate/planner";
import { MessageSquareText, ShieldQuestion } from "lucide-react";
import { useState } from "react";

import { IntentLink, MarketName } from "@/components/domain/Intent";
import { Card } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { Tabs } from "@/components/ui/Tabs";
import { type OrderOnChain, executionSummary, planExecution } from "@/lib/hedge/execution";
import type { AgentPlanView, PreviewState } from "@/lib/hedge/types";
import {
  formatContractPrice,
  formatContractsHundredths,
  formatDateUtc,
  formatTimeUtc,
  formatUsdCents,
} from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { describeMarket } from "@/lib/markets";

import styles from "./hedge.module.css";
import { HoldingsEditor } from "./HoldingsEditor";
import { LiveLadder, ladderCaption } from "./LiveLadder";
import { PayoffChart } from "./PayoffChart";
import { PlanDetails } from "./PlanDetails";
import { useHedgeMarket } from "./useHedgeMarket";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });
const at = (iso: string) => `${formatDateUtc(iso)} at ${formatTimeUtc(iso)}`;

const SIGNAL_IGNORED: Record<string, string> = {
  asset_mismatch: "it was about another asset",
  event_mismatch: "it was about another expiry",
  no_matching_strikes: "none of its strikes are on this ladder",
};

const orderColumns: readonly Column<OrderOnChain>[] = [
  {
    key: "strike",
    header: "Pays if below",
    cell: ({ order }) => <span className="num">{usd(order.strikeCents)}</span>,
    nowrap: true,
  },
  {
    key: "market",
    header: "Market",
    cell: ({ order }) => <MarketName symbol={order.instrumentSymbol} />,
    role: "primary",
  },
  {
    key: "contracts",
    header: "Contracts",
    cell: ({ order }) => (
      <span className="num">{formatContractsHundredths(order.quantityHundredths)} NO</span>
    ),
    align: "end",
    nowrap: true,
  },
  {
    key: "limit",
    header: "Limit",
    cell: ({ order }) => <span className="num">{formatContractPrice(order.limitPriceCents)}</span>,
    align: "end",
    nowrap: true,
  },
  {
    key: "cost",
    header: "Cost",
    cell: ({ order }) => <Money cents={order.amountCents} />,
    align: "end",
    nowrap: true,
  },
  {
    key: "chain",
    header: "On chain",
    cell: ({ intent }) =>
      intent ? (
        <span className={styles.onChain}>
          <IntentLink id={intent.id} />
          <StatusChip status={intent.status} reason={intent.reason} />
        </span>
      ) : (
        <span className={styles.notBought}>Not proposed</span>
      ),
    nowrap: true,
  },
];

/** The point of the payoff table nearest the plan's spot, where the readout starts. */
function spotIndex(plan: HedgePlan): number {
  let best = 0;
  plan.payoff.forEach((point, index) => {
    const current = plan.payoff[best];
    if (
      current &&
      Math.abs(point.priceCents - plan.spotCents) < Math.abs(current.priceCents - plan.spotCents)
    ) {
      best = index;
    }
  });
  return best;
}

function boughtBySymbol(plan: HedgePlan | null): Map<string, number> {
  const bought = new Map<string, number>();
  for (const rung of plan?.rungs ?? []) {
    if (rung.quantityHundredths > 0) bought.set(rung.instrumentSymbol, rung.quantityHundredths);
  }
  return bought;
}

/** The payoff chart, and the exact table it is drawn from for anyone who wants every number. */
function Payoff({ plan, label }: { plan: HedgePlan; label: string }) {
  const settles = describeMarket(plan.rungs[0]?.instrumentSymbol ?? "").settles;
  return (
    <Card
      title={settles ? `Payoff on ${settles}` : "Payoff at settlement"}
      description={`${label}: profit or loss against today's spot of ${usd(plan.spotCents)}, by where ${plan.asset} settles.`}
      headingLevel={2}
    >
      {plan.payoff.length > 1 ? (
        <>
          <PayoffChart
            key={plan.planId}
            asset={plan.asset}
            points={plan.payoff}
            spotCents={plan.spotCents}
            strikesCents={plan.rungs
              .filter((rung) => rung.quantityHundredths > 0)
              .map((rung) => rung.strikeCents)}
            initialIndex={spotIndex(plan)}
          />
          <details className={styles.payoffTable}>
            <summary>Every settlement price the planner checked</summary>
            <Table
              caption={`Payoff by settlement price for ${label.toLowerCase()}`}
              captionHidden
              columns={[
                {
                  key: "price",
                  header: `${plan.asset} settles at`,
                  cell: (point) => <span className="num">{usd(point.priceCents)}</span>,
                  nowrap: true,
                },
                {
                  key: "alone",
                  header: `${plan.asset} alone`,
                  cell: (point) => <Money cents={point.unhedgedPnlCents} sign="always" />,
                  align: "end",
                  nowrap: true,
                },
                {
                  key: "hedge",
                  header: "Hedge",
                  cell: (point) => <Money cents={point.hedgePnlCents} sign="always" />,
                  align: "end",
                  nowrap: true,
                },
                {
                  key: "net",
                  header: "Combined",
                  cell: (point) => <Money cents={point.netPnlCents} sign="always" />,
                  align: "end",
                  nowrap: true,
                },
              ]}
              rows={[...plan.payoff].reverse()}
              rowKey={(point) => point.priceCents.toString()}
            />
          </details>
        </>
      ) : (
        <EmptyState plain title="No payoff to draw">
          The plan buys no contracts, so the holding is exposed exactly as it is without a hedge.
        </EmptyState>
      )}
    </Card>
  );
}

function AgentPlanCard({
  view,
  snapshot,
  agentName,
}: {
  view: AgentPlanView;
  snapshot: ConsoleSnapshot;
  agentName: string;
}) {
  const { plan } = view;
  const execution = planExecution(plan, snapshot.chain);
  const settles = describeMarket(plan.rungs[0]?.instrumentSymbol ?? "").settles;
  const signal = plan.signal;
  return (
    <>
      <Card
        title={`${agentName}'s plan`}
        description={`Planned ${at(view.createdAt)}${view.createdAt === view.storedAt ? "" : `, stored ${at(view.storedAt)}`}.`}
        headingLevel={2}
        className={styles.planCard}
      >
        <div className={styles.plan} data-testid="agent-plan" data-plan-id={view.planId}>
          {view.requestText ? (
            <blockquote className={styles.request}>
              <MessageSquareText aria-hidden />
              <p>{view.requestText}</p>
            </blockquote>
          ) : null}
          <p className={styles.execution} data-testid="plan-execution" role="status">
            {executionSummary(execution, plan.orders.length)}
          </p>
          <PlanDetails plan={plan} settles={settles} />
          <p className={styles.signal} data-testid="plan-signal">
            <strong>Paid signal.</strong>{" "}
            {signal ? (
              <>
                {signal.used
                  ? signal.changedOrders
                    ? "Used, and it changed which rungs were bought."
                    : "Used; the orders are the same as without it."
                  : `Bought but ignored, because ${SIGNAL_IGNORED[signal.ignoredBecause ?? ""] ?? "it did not fit this ladder"}.`}{" "}
                <span className={styles.receipt}>
                  Receipt <code>{signal.receiptId}</code>
                </span>
              </>
            ) : (
              "None: the plan uses Gemini's quotes only."
            )}
          </p>
        </div>
      </Card>
      <Card
        title="Orders"
        description="Each order of the plan and the intent that proposed it on the Policy contract. An intent counts only when its sealed reason names this plan."
        padding="flush"
        headingLevel={2}
      >
        <Table
          caption={`Orders of plan ${view.planId}`}
          captionHidden
          columns={orderColumns}
          rows={execution.orders}
          rowKey={(entry) => `${entry.index.toString()}:${entry.order.instrumentSymbol}`}
          empty={
            <EmptyState plain title="No orders">
              The plan buys nothing. Its warnings say why.
            </EmptyState>
          }
        />
      </Card>
    </>
  );
}

function NoPlanCard({
  asset,
  holding,
  preview,
  agentName,
}: {
  asset: string;
  holding: string | null;
  preview: PreviewState | null;
  agentName: string;
}) {
  const who = agentName === "The agent" ? "the agent" : agentName;
  const ask = `Protect my ${holding ?? "0.05"} ${asset} down to 10% below today's price this week.`;
  return (
    <Card title="The plan" headingLevel={2} className={styles.planCard}>
      <EmptyState
        plain
        icon={<ShieldQuestion strokeWidth={1.75} />}
        title={`${agentName} has not planned a hedge for ${asset}`}
      >
        {holding
          ? `Ask ${who} in your chat, for example: `
          : `Save what you hold, then ask ${who}, for example: `}
        <q className={styles.ask}>{ask}</q> Its plan appears here as soon as it is made.
      </EmptyState>
      {preview?.status === "ready" ? (
        <div className={styles.preview} data-testid="hedge-preview">
          <p className={styles.previewLabel}>
            <strong>Preview, not {agentName === "The agent" ? "the agent" : agentName}&rsquo;s plan.</strong>{" "}
            The console ran the same planner on your {preview.assumptions.holdingQuantity} {asset}, the
            mandate&rsquo;s limits and Gemini&rsquo;s live quotes, assuming protection down to{" "}
            {preview.assumptions.dropPercent}% below spot for at most{" "}
            {formatUsdCents(preview.assumptions.maxCostCents)} (the budget left). Nothing is stored or
            proposed.
          </p>
          <PlanDetails
            plan={preview.plan}
            settles={describeMarket(preview.plan.rungs[0]?.instrumentSymbol ?? "").settles}
          />
        </div>
      ) : preview?.status === "unavailable" ? (
        <p className={styles.previewUnavailable} data-testid="hedge-preview" data-state="unavailable">
          No preview: {preview.reason}
        </p>
      ) : null}
    </Card>
  );
}

/** One asset's hedge: the agent's plan or an honest empty state, its payoff, and the live ladder. */
function AssetHedge({
  asset,
  snapshot,
  isPreviewPage,
}: {
  asset: string;
  snapshot: ConsoleSnapshot;
  isPreviewPage: boolean;
}) {
  const agentName = snapshot.offchain.pairing?.agentName ?? "The agent";
  const agentPlan = snapshot.offchain.plans.find((plan) => plan.asset === asset) ?? null;
  const holding = snapshot.offchain.holdings.find((candidate) => candidate.asset === asset)?.quantity ?? null;
  const market = useHedgeMarket({
    asset,
    eventTicker: agentPlan?.plan.eventTicker ?? null,
    preview: agentPlan === null,
    inputsKey: JSON.stringify([
      snapshot.offchain.holdingsUpdatedAt,
      snapshot.chain?.rules ?? null,
      snapshot.chain?.committedCents ?? 0,
    ]),
    enabled: !isPreviewPage,
  });
  const preview = market.status === "ready" ? market.data.preview : null;
  const previewPlan = preview?.status === "ready" ? preview.plan : null;
  const shown = agentPlan?.plan ?? previewPlan;
  const quotes = market.status === "ready" ? market.data.quotes : null;

  return (
    <div className={styles.asset}>
      {agentPlan ? (
        <AgentPlanCard view={agentPlan} snapshot={snapshot} agentName={agentName} />
      ) : (
        <NoPlanCard asset={asset} holding={holding} preview={preview} agentName={agentName} />
      )}
      {shown ? <Payoff plan={shown} label={agentPlan ? `${agentName}'s plan` : "The preview"} /> : null}
      <Card
        title="Live ladder"
        description={
          ladderCaption(quotes) ??
          (agentPlan
            ? `Gemini's quotes for ${agentPlan.plan.eventTicker}, the event the plan is on.`
            : `Gemini's quotes for the soonest weekly ${asset} event.`)
        }
        padding="flush"
        headingLevel={2}
      >
        <LiveLadder
          asset={asset}
          market={market}
          bought={boughtBySymbol(shown)}
          planLabel={agentPlan ? "In the plan" : previewPlan ? "In the preview" : "Bought"}
        />
      </Card>
    </div>
  );
}

/**
 * The owner's holdings (real, signed by the owner) and the hedge the agent planned for each of them: its
 * latest stored plan, whether it reached the chain, its payoff and the live ladder it was planned on.
 * With no plan the page says how to get one, and can show a labelled preview from the same planner.
 */
export function HedgeView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const { holdings, holdingsUpdatedAt, plans } = snapshot.offchain;
  const assets = [
    ...new Set([...plans.map((plan) => plan.asset), ...holdings.map((holding) => holding.asset)]),
  ];
  if (assets.length === 0) assets.push("BTC");
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && assets.includes(selected) ? selected : (assets[0] ?? "BTC");

  return (
    <div className={styles.view}>
      <PageHeader
        title="Hedge"
        description="Protection for what you hold, bought as a ladder of “below” contracts that pay $1 each if the price ends under the strike."
      />

      <Card
        title="What you hold"
        description="The agent reads this to size a hedge. Saving it needs the owner wallet's signature."
        headingLevel={2}
      >
        <HoldingsEditor holdings={holdings} updatedAt={holdingsUpdatedAt} />
      </Card>

      {assets.length > 1 ? (
        <Tabs
          label="Asset"
          selected={current}
          onSelect={setSelected}
          tabs={assets.map((asset) => ({
            id: asset,
            label: asset,
            content: <AssetHedge asset={asset} snapshot={snapshot} isPreviewPage={preview !== undefined} />,
          }))}
        />
      ) : (
        <AssetHedge asset={current} snapshot={snapshot} isPreviewPage={preview !== undefined} />
      )}
    </div>
  );
}
