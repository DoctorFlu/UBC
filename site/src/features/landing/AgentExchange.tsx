"use client";

import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";

import styles from "./agents.module.css";

const MARKET = "GEMI-BTC2611202200-HI63000";

/* Three proposals to the sample mandate. The tool results are the MCP server's summaries word for word
   (agent/src/tools/propose-trade.ts); only the intent numbers and the request are examples. */
const EXCHANGES = [
  {
    id: "approved",
    tab: "Approved",
    request: "Buy $18 of NO on BTC at or above $63,000 on Nov 20.",
    amountCents: 1800,
    result: `Intent #7 approved: buy NO ${MARKET} for $18.00 at 41c. The executor places approved orders. Decision context sealed onchain.`,
  },
  {
    id: "held",
    tab: "Held",
    request: "Make it $22 instead.",
    amountCents: 2200,
    result: `Intent #8 is waiting for the owner's approval: buy NO ${MARKET} for $22.00 at 41c. Trades above $20.00 need the owner's approval; this one is $22.00. Decision context sealed onchain.`,
  },
  {
    id: "rejected",
    tab: "Rejected",
    request: "Go to $30.",
    amountCents: 3000,
    result: `Intent #9 rejected by the mandate (over max trade size): buy NO ${MARKET} for $30.00 at 41c. This trade is larger than the maximum size the owner allows for a single trade. Max trade $25.00; this trade $30.00.`,
  },
] as const;

export function AgentExchange() {
  return (
    <Tabs className={styles.exchange} defaultValue="approved">
      <div className={styles.exchangeHead}>
        <p className={styles.exchangeTitle}>A sample exchange with Grok Bot</p>
        <TabsList className={styles.tabList} aria-label="Outcome">
          <TabsIndicator className={styles.tabIndicator} />
          {EXCHANGES.map((exchange) => (
            <TabsTab key={exchange.id} value={exchange.id} className={styles.tab} data-tone={exchange.id}>
              <span className={styles.tabLamp} aria-hidden="true" />
              {exchange.tab}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      {EXCHANGES.map((exchange) => (
        <TabsPanel key={exchange.id} value={exchange.id} className={styles.panel}>
          <dl className={styles.turns}>
            <div className={styles.turn}>
              <dt>You, in the chat</dt>
              <dd className={styles.you}>{exchange.request}</dd>
            </div>
            <div className={styles.turn}>
              <dt>Grok Bot calls</dt>
              <dd>
                <pre className={styles.call}>
                  <code>
                    {`propose_trade {
  market: "${MARKET}",
  outcome: "NO", side: "buy",
  amountCents: ${String(exchange.amountCents)}, limitPrice: 41
}`}
                  </code>
                </pre>
              </dd>
            </div>
            <div className={styles.turn}>
              <dt>The server answers</dt>
              <dd className={styles.result} data-tone={exchange.id}>
                {exchange.result}
              </dd>
            </div>
          </dl>
        </TabsPanel>
      ))}
    </Tabs>
  );
}
