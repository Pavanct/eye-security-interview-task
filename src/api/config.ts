import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

  UPSTREAM_BASE_URL: z.url().default("https://api.heyering.com"),
  // No default: the service must not start without credentials, and a key must never live in code.
  UPSTREAM_API_KEY: z.string().min(1),

  MAX_RECORDS_PER_REQUEST: positiveInt(5000),
  HEARTBEAT_INTERVAL_MS: positiveInt(5000),

  ENRICHMENT_CONCURRENCY: positiveInt(5),
  ENRICHMENT_TIMEOUT_MS: positiveInt(5000),
  // Probing the real service showed about 23% of calls return a 500, so 3 attempts would
  // lose about 1% of records (0.23^3). With 5 it is under 0.1%.
  ENRICHMENT_MAX_ATTEMPTS: positiveInt(5),
  RETRY_BASE_DELAY_MS: positiveInt(200),
  RETRY_MAX_DELAY_MS: positiveInt(5000),

  // Above 20 the real service answers 400, so a larger value can only ever break.
  ANALYTICS_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(20),
  // The limit is 1 request per 10 s. The extra 500 ms stops network jitter from
  // landing a request just inside the previous window and wasting it on a 429.
  ANALYTICS_INTERVAL_MS: positiveInt(10_500),
  ANALYTICS_TIMEOUT_MS: positiveInt(10_000),
  ANALYTICS_MAX_ATTEMPTS: positiveInt(3),
});

export interface Config {
  port: number;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  maxRecordsPerRequest: number;
  heartbeatIntervalMs: number;
  upstream: { baseUrl: string; apiKey: string };
  enrichment: {
    concurrency: number;
    timeoutMs: number;
    retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  };
  analytics: { batchSize: number; intervalMs: number; timeoutMs: number; maxAttempts: number };
}

// Fails at startup rather than on the first request. The error names the bad
// variables but never their values, because one of them is the API key.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${names}`);
  }
  const e = parsed.data;

  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    maxRecordsPerRequest: e.MAX_RECORDS_PER_REQUEST,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    upstream: { baseUrl: e.UPSTREAM_BASE_URL, apiKey: e.UPSTREAM_API_KEY },
    enrichment: {
      concurrency: e.ENRICHMENT_CONCURRENCY,
      timeoutMs: e.ENRICHMENT_TIMEOUT_MS,
      retry: {
        maxAttempts: e.ENRICHMENT_MAX_ATTEMPTS,
        baseDelayMs: e.RETRY_BASE_DELAY_MS,
        maxDelayMs: e.RETRY_MAX_DELAY_MS,
      },
    },
    analytics: {
      batchSize: e.ANALYTICS_BATCH_SIZE,
      intervalMs: e.ANALYTICS_INTERVAL_MS,
      timeoutMs: e.ANALYTICS_TIMEOUT_MS,
      maxAttempts: e.ANALYTICS_MAX_ATTEMPTS,
    },
  };
}
