import { serve } from "@hono/node-server";
import { loadEnv } from "@mandate/shared";
import { createSignalsApp } from "./app";
import { readSignalsConfig } from "./config";

loadEnv();
const config = readSignalsConfig();
const app = createSignalsApp({
  sellerAddress: config.sellerAddress,
  network: config.network,
  facilitatorUrl: config.facilitatorUrl,
});

// Idle keep-alive must outlast the proxy in front of this server (cloudflared reuses an idle
// origin connection for up to 90 s; Node's 5 s default turns that reuse into sporadic 502s).
const KEEP_ALIVE_TIMEOUT_MS = 120_000;

serve(
  { fetch: app.fetch, port: config.port, serverOptions: { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS } },
  (info) => {
    console.log(`signals listening on http://localhost:${info.port}`);
    console.log(`seller ${config.sellerAddress} on ${config.network} via ${config.facilitatorUrl}`);
  },
);
