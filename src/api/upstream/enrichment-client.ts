import { withRetry, type AttemptOutcome, type Result, type RetryDeps, type RetryPolicy } from "../lib/retry.js";
import { enrichmentResponseSchema, type EnrichmentDetails, type LogLine } from "./schemas.js";
import { postJson, type UpstreamHttp } from "./http.js";

export class HttpEnricher {
  constructor(
    private readonly http: UpstreamHttp,
    private readonly timeoutMs: number,
    private readonly policy: RetryPolicy,
    private readonly deps: RetryDeps,
  ) {}

  enrich(logLine: LogLine, signal?: AbortSignal): Promise<Result<EnrichmentDetails> & { attempts: number }> {
    return withRetry((s) => this.attempt(logLine, s), this.policy, this.deps, signal);
  }

  private async attempt(logLine: LogLine, signal?: AbortSignal): Promise<AttemptOutcome<EnrichmentDetails>> {
    const outcome = await postJson(this.http, "/enrichment", logLine, this.timeoutMs, signal);

    switch (outcome.kind) {
      case "aborted":
        return { kind: "permanent", reason: "aborted" };
      case "timeout":
        return { kind: "retryable", reason: "enrichment timed out" };
      case "network":
        return { kind: "retryable", reason: "enrichment unreachable" };
    }

    if (outcome.status === 200) {
      const parsed = enrichmentResponseSchema.safeParse(outcome.body);
      // Enrichment only reads data, so retrying after a bad body can't cause harm.
      return parsed.success
        ? { kind: "success", value: parsed.data }
        : { kind: "retryable", reason: "enrichment returned an invalid response" };
    }

    // 401 isn't in the spec, but the real service returns it for a bad key.
    if (outcome.status === 401 || outcome.status === 403) {
      return { kind: "permanent", reason: "enrichment rejected the API key" };
    }
    if (outcome.status === 429 || outcome.status >= 500) {
      return { kind: "retryable", reason: "enrichment unavailable" };
    }
    return { kind: "permanent", reason: "enrichment rejected the record" };
  }
}
