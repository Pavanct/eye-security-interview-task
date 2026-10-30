import type { IntervalRateLimiter } from "../lib/rate-limiter.js";
import { withRetry, type AttemptOutcome, type Result, type RetryDeps } from "../lib/retry.js";
import { analyticsResponseSchema, type AnalyticsEvent, type AnalyticsResponse } from "./schemas.js";
import { postJson, type UpstreamHttp } from "./http.js";

export class HttpAnalyticsSink {
  constructor(
    private readonly http: UpstreamHttp,
    private readonly limiter: IntervalRateLimiter,
    private readonly timeoutMs: number,
    private readonly maxAttempts: number,
    private readonly deps: RetryDeps,
  ) {}

  send(events: AnalyticsEvent[], signal?: AbortSignal): Promise<Result<AnalyticsResponse> & { attempts: number }> {
    // No backoff delay: every attempt, retries included, has to get a slot from the
    // limiter, and that wait is already longer than any backoff would be.
    const policy = { maxAttempts: this.maxAttempts, baseDelayMs: 0, maxDelayMs: 0 };
    return withRetry((s) => this.attempt(events, s), policy, this.deps, signal);
  }

  private async attempt(events: AnalyticsEvent[], signal?: AbortSignal): Promise<AttemptOutcome<AnalyticsResponse>> {
    if (!(await this.limiter.acquire(signal))) return { kind: "permanent", reason: "aborted" };

    const outcome = await postJson(this.http, "/analytics", events, this.timeoutMs, signal);

    switch (outcome.kind) {
      case "aborted":
        return { kind: "permanent", reason: "aborted" };
      case "timeout":
        // The batch may have been stored even though we got no answer, so this retry
        // can create duplicates. Accepted: for incident response, a duplicate is less
        // harmful than a lost event (see ADR-4).
        return { kind: "retryable", reason: "analytics timed out" };
      case "network":
        return { kind: "retryable", reason: "analytics unreachable" };
    }

    if (outcome.status === 200) return this.classifySuccess(outcome.body);

    if (outcome.status === 429) {
      if (outcome.retryAfterMs !== undefined) this.limiter.defer(outcome.retryAfterMs);
      return { kind: "retryable", reason: "analytics rate limited the request" };
    }
    if (outcome.status === 401 || outcome.status === 403) {
      return { kind: "permanent", reason: "analytics rejected the API key" };
    }
    if (outcome.status >= 500) return { kind: "retryable", reason: "analytics unavailable" };
    return { kind: "permanent", reason: "analytics rejected the batch" };
  }

  private classifySuccess(body: unknown): AttemptOutcome<AnalyticsResponse> {
    const parsed = analyticsResponseSchema.safeParse(body);
    // Not retried: it was a 200, so the batch may well be stored already.
    if (!parsed.success) return { kind: "permanent", reason: "analytics returned an invalid response" };

    // Safe to retry only when nothing was stored. If some items were, a retry would
    // duplicate them, so a partial result is returned for the caller to report.
    if (parsed.data.status === "error" && parsed.data.itemsIngested === 0) {
      return { kind: "retryable", reason: "analytics reported an error" };
    }
    return { kind: "success", value: parsed.data };
  }
}
