import { serve } from "@hono/node-server";
import { pino } from "pino";
import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { IntervalRateLimiter } from "./lib/rate-limiter.js";
import { sleep } from "./lib/timing.js";
import { HttpAnalyticsSink } from "./upstream/analytics-client.js";
import { HttpEnricher } from "./upstream/enrichment-client.js";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Invalid configuration");
  process.exit(1);
}

const logger = pino({ level: config.logLevel });

const http = { ...config.upstream, fetch: globalThis.fetch };
const retryDeps = { sleep, random: Math.random };
// One limiter for the whole process: concurrent runs share the same upstream budget.
const limiter = new IntervalRateLimiter(config.analytics.intervalMs, Date.now, sleep);

const app = createApp({
  pipeline: {
    enricher: new HttpEnricher(http, config.enrichment.timeoutMs, config.enrichment.retry, retryDeps),
    sink: new HttpAnalyticsSink(http, limiter, config.analytics.timeoutMs, config.analytics.maxAttempts, retryDeps),
    batchSize: config.analytics.batchSize,
  },
  maxRecordsPerRequest: config.maxRecordsPerRequest,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  logger,
});

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  logger.info({ port }, "api listening");
});
