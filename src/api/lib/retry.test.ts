import { describe, expect, it } from "vitest";
import { withRetry, type AttemptOutcome, type RetryDeps } from "./retry.js";

const policy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 300 };

function harness(outcomes: Array<AttemptOutcome<string>>, random = 1) {
  const sleeps: number[] = [];
  let calls = 0;
  const deps: RetryDeps = {
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
    random: () => random,
  };
  const attempt = async () => {
    const outcome = outcomes[calls++];
    if (!outcome) throw new Error("attempted more often than expected");
    return outcome;
  };
  return { deps, attempt, sleeps, calls: () => calls };
}

const fail = { kind: "retryable", reason: "upstream unavailable" } as const;
const ok = { kind: "success", value: "done" } as const;

describe("given the first attempt succeeds", () => {
  it("when retrying, then it returns without waiting", async () => {
    const { deps, attempt, sleeps } = harness([ok]);

    const result = await withRetry(attempt, policy, deps);

    expect(result).toEqual({ ok: true, value: "done", attempts: 1 });
    expect(sleeps).toEqual([]);
  });
});

describe("given attempts fail and then one succeeds", () => {
  it("when retrying, then it returns the value and how many attempts it took", async () => {
    const { deps, attempt } = harness([fail, fail, ok]);

    const result = await withRetry(attempt, policy, deps);

    expect(result).toEqual({ ok: true, value: "done", attempts: 3 });
  });

  it("when backing off, then the delay doubles up to the cap", async () => {
    const { deps, attempt, sleeps } = harness([fail, fail, fail, ok]);

    await withRetry(attempt, policy, deps);

    expect(sleeps).toEqual([100, 200, 300]);
  });

  it("when jitter applies, then the delay is a fraction of the ceiling", async () => {
    const { deps, attempt, sleeps } = harness([fail, ok], 0.5);

    await withRetry(attempt, policy, deps);

    expect(sleeps).toEqual([50]);
  });
});

describe("given every attempt fails", () => {
  it("when attempts run out, then it returns the last reason without a final wait", async () => {
    const { deps, attempt, sleeps, calls } = harness([fail, fail, fail, fail]);

    const result = await withRetry(attempt, policy, deps);

    expect(result).toEqual({ ok: false, reason: "upstream unavailable", attempts: 4 });
    expect(calls()).toBe(4);
    expect(sleeps).toHaveLength(3);
  });
});

describe("given a permanent failure", () => {
  it("when it happens, then it stops immediately", async () => {
    const { deps, attempt, calls } = harness([{ kind: "permanent", reason: "rejected" }]);

    const result = await withRetry(attempt, policy, deps);

    expect(result).toEqual({ ok: false, reason: "rejected", attempts: 1 });
    expect(calls()).toBe(1);
  });
});

describe("given a fatal failure", () => {
  it("when it happens, then it stops immediately and marks the result as fatal", async () => {
    const { deps, attempt, calls } = harness([{ kind: "fatal", reason: "bad key" }]);

    const result = await withRetry(attempt, policy, deps);

    expect(result).toEqual({ ok: false, reason: "bad key", fatal: true, attempts: 1 });
    expect(calls()).toBe(1);
  });
});

describe("given the run is aborted", () => {
  it("when it was aborted before starting, then no attempt is made", async () => {
    const { deps, attempt, calls } = harness([ok]);

    const result = await withRetry(attempt, policy, deps, AbortSignal.abort());

    expect(result).toEqual({ ok: false, reason: "aborted", attempts: 0 });
    expect(calls()).toBe(0);
  });

  it("when it is aborted during a backoff wait, then it stops", async () => {
    const { attempt, calls } = harness([fail, ok]);
    const deps: RetryDeps = { sleep: async () => false, random: () => 1 };

    const result = await withRetry(attempt, policy, deps);

    expect(result).toEqual({ ok: false, reason: "aborted", attempts: 1 });
    expect(calls()).toBe(1);
  });
});
