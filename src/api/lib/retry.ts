import type { Sleep } from "./timing.js";

// fatal means no other record can succeed either, so the whole run should stop.
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string; fatal?: true };

// Each client decides what is worth retrying. This module only decides when.
export type AttemptOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "retryable"; reason: string }
  | { kind: "permanent"; reason: string }
  | { kind: "fatal"; reason: string };

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryDeps {
  sleep: Sleep;
  random: () => number;
  // A successful retry otherwise leaves no trace of why the first attempt failed.
  onRetry?: (reason: string, attempt: number) => void;
}

export async function withRetry<T>(
  attempt: (signal?: AbortSignal) => Promise<AttemptOutcome<T>>,
  policy: RetryPolicy,
  deps: RetryDeps,
  signal?: AbortSignal,
): Promise<Result<T> & { attempts: number }> {
  let lastReason = "no attempts made";

  for (let n = 1; n <= policy.maxAttempts; n++) {
    if (signal?.aborted) return { ok: false, reason: "aborted", attempts: n - 1 };

    const outcome = await attempt(signal);
    if (outcome.kind === "success") return { ok: true, value: outcome.value, attempts: n };
    if (outcome.kind === "permanent") return { ok: false, reason: outcome.reason, attempts: n };
    if (outcome.kind === "fatal") return { ok: false, reason: outcome.reason, fatal: true, attempts: n };

    lastReason = outcome.reason;
    if (n === policy.maxAttempts) break;
    deps.onRetry?.(outcome.reason, n);

    // Full jitter: with records enriched concurrently, a fixed backoff would send
    // every failed call back at the same moment and hit a struggling service together.
    const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (n - 1));
    const waitMs = deps.random() * ceiling;
    if (waitMs > 0 && !(await deps.sleep(waitMs, signal))) {
      return { ok: false, reason: "aborted", attempts: n };
    }
  }

  return { ok: false, reason: lastReason, attempts: policy.maxAttempts };
}
