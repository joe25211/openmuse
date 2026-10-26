import { serve } from "@hono/node-server";
import { createBridgeApp } from "./app.ts";
import { bridgeConfig } from "./config.ts";
import { createHermesUpstream } from "./hermes.ts";

const config = bridgeConfig();
const app = createBridgeApp(config, { upstream: createHermesUpstream(config) });

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(
    `OpenMuse bridge ready at http://${config.host}:${config.port} -> ${config.hermesBaseUrl}`,
  ),
);
