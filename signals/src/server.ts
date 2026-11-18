import { serve } from "@hono/node-server";
import { createMarketDataClient, marketDataSource } from "@mandate/gemini";
import { loadEnv } from "@mandate/shared";
import { createSignalsApp } from "./app";
import { readSignalsConfig } from "./config";
import { createHedgeRoute } from "./routes/hedge";
import { helloRoute } from "./routes/hello";
import { DEFAULT_SIGNAL_MODEL } from "./signal/build";
import { createHedgeSignalService } from "./signal/service";

loadEnv();
const config = readSignalsConfig();
/** Which Gemini the signals price: the same rule as the console, the MCP server and the executor. */
const marketData = marketDataSource(process.env);

/**
 * Public Gemini market data, cached so that request volume never turns into Gemini volume: at most
 * one events listing a minute, one event and one spot ticker every five seconds per ladder and asset,
 * and one candle series every five minutes per asset. The client's token bucket stays under Gemini's
 * public limit of 120 requests a minute regardless. Books and listings come from the venue's exchange,
 * spot and candles from production's, whose index the ladders settle on (`createMarketDataClient`).
 */
const gemini = createMarketDataClient(marketData, {
  cacheTtlMs: { events: 60_000, event: 5_000, spot: 5_000, candles: 300_000 },
});

const hedgeRoute = createHedgeRoute({
  priceUsd: config.hedge.priceUsd,
  service: createHedgeSignalService({
    source: gemini,
    assets: config.hedge.assets,
    model: {
      ...DEFAULT_SIGNAL_MODEL,
      fairBandBps: config.hedge.fairBandCents * 100,
      volWindowHours: config.hedge.volWindowHours,
    },
  }),
});

const app = createSignalsApp({
  sellerAddress: config.sellerAddress,
  network: config.network,
  facilitatorUrl: config.facilitatorUrl,
  routes: [helloRoute, hedgeRoute],
  marketEnvironment: marketData.environment,
});

// Idle keep-alive must outlast the proxy in front of this server (cloudflared reuses an idle
// origin connection for up to 90 s; Node's 5 s default turns that reuse into sporadic 502s).
const KEEP_ALIVE_TIMEOUT_MS = 120_000;

serve(
  { fetch: app.fetch, port: config.port, serverOptions: { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS } },
  (info) => {
    console.log(`signals listening on http://localhost:${info.port}`);
    console.log(`seller ${config.sellerAddress} on ${config.network} via ${config.facilitatorUrl}`);
    console.log(`market data from Gemini's ${marketData.environment} (${marketData.settings})`);
    console.log(
      `hedge signal $${config.hedge.priceUsd} per request for ${config.hedge.assets.join(", ")}, ` +
        `fair band ${config.hedge.fairBandCents} cents, volatility window ${config.hedge.volWindowHours} hours`,
    );
  },
);
