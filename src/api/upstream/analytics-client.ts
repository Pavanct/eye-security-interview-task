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

  async send(
    events: AnalyticsEvent[],
    signal?: AbortSignal,
  ): Promise<Result<AnalyticsResponse> & { attempts: number; mayBeDuplicated?: boolean }> {
    // No backoff delay: every attempt, retries included, has to get a slot from the
    // limiter, and that wait is already longer than any backoff would be.
    const policy = { maxAttempts: this.maxAttempts, baseDelayMs: 0, maxDelayMs: 0 };

    // Set when an attempt fails without telling us whether the batch was stored. The API
    // has no idempotency key, so a retry after that can store it twice. We retry anyway,
    // because a duplicate is less harmful than a lost event, but the caller must be told.
    let outcomeUnclear = false;
    const markUnclear = () => {
      outcomeUnclear = true;
    };

    const result = await withRetry((s) => this.attempt(events, markUnclear, s), policy, this.deps, signal);

    if (!outcomeUnclear) return result;
    return result.ok
      ? { ...result, mayBeDuplicated: true }
      : { ...result, reason: `${result.reason}, and the batch may already be stored` };
  }

  private async attempt(
    events: AnalyticsEvent[],
    markUnclear: () => void,
    signal?: AbortSignal,
  ): Promise<AttemptOutcome<AnalyticsResponse>> {
    if (!(await this.limiter.acquire(signal))) return { kind: "permanent", reason: "aborted" };

    const outcome = await postJson(this.http, "/analytics", events, this.timeoutMs, signal);

    switch (outcome.kind) {
      case "aborted":
        return { kind: "permanent", reason: "aborted" };
      case "timeout":
        markUnclear();
        return { kind: "retryable", reason: "analytics timed out" };
      case "network":
        markUnclear();
        return { kind: "retryable", reason: "analytics unreachable" };
    }

    if (outcome.status === 200) return this.classifySuccess(outcome.body, events.length);

    if (outcome.status === 429) {
      if (outcome.retryAfterMs !== undefined) this.limiter.defer(outcome.retryAfterMs);
      return { kind: "retryable", reason: "analytics rate limited the request" };
    }
    if (outcome.status === 401 || outcome.status === 403) {
      return { kind: "fatal", reason: "analytics rejected the API key" };
    }
    if (outcome.status >= 500) {
      markUnclear();
      return { kind: "retryable", reason: "analytics unavailable" };
    }
    return { kind: "permanent", reason: "analytics rejected the batch" };
  }

  private classifySuccess(body: unknown, sent: number): AttemptOutcome<AnalyticsResponse> {
    const parsed = analyticsResponseSchema.safeParse(body);
    // Not retried: it was a 200, so the batch may well be stored already. The same goes
    // for a count we can't believe, which also must not inflate the stored total.
    if (!parsed.success || parsed.data.itemsIngested > sent) {
      return { kind: "permanent", reason: "analytics returned an invalid response" };
    }

    const { status, itemsIngested } = parsed.data;
    // Safe to retry only when nothing was stored. If some items were, a retry would
    // duplicate them.
    if (itemsIngested === 0) return { kind: "retryable", reason: "analytics stored nothing" };
    if (status === "error") {
      return { kind: "permanent", reason: "analytics reported an error, and the batch may be partly stored" };
    }
    return { kind: "success", value: parsed.data };
  }
}
