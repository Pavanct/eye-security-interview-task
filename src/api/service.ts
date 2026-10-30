import type { Hono } from "hono";
import type { Logger } from "pino";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { IntervalRateLimiter } from "./lib/rate-limiter.js";
import { sleep } from "./lib/timing.js";
import { HttpAnalyticsSink } from "./upstream/analytics-client.js";
import { HttpEnricher } from "./upstream/enrichment-client.js";

// All the wiring, in one place. Separate from main.ts so the integration tests run the
// same object graph as production, not a copy of it.
export function createService(config: Config, shutdown: AbortSignal, logger: Logger): Hono {
  const http = { ...config.upstream, fetch: globalThis.fetch };
  const retryDeps = {
    sleep,
    random: Math.random,
    onRetry: (reason: string, attempt: number) => logger.info({ reason, attempt }, "upstream call failed, retrying"),
  };
  // One limiter for the whole process: concurrent runs share the same upstream budget.
  const limiter = new IntervalRateLimiter(config.analytics.intervalMs, Date.now, sleep);

  return createApp({
    pipeline: {
      enricher: new HttpEnricher(http, config.enrichment.timeoutMs, config.enrichment.retry, retryDeps),
      sink: new HttpAnalyticsSink(http, limiter, config.analytics.timeoutMs, config.analytics.maxAttempts, retryDeps),
      batchSize: config.analytics.batchSize,
      shutdown,
    },
    maxRecordsPerRequest: config.maxRecordsPerRequest,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    logger,
  });
}
