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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`signals listening on http://localhost:${info.port}`);
  console.log(`seller ${config.sellerAddress} on ${config.network} via ${config.facilitatorUrl}`);
});
