import { describe, expect, it, vi } from "vitest";
import { IntervalRateLimiter } from "./rate-limiter.js";

const INTERVAL = 10_000;

function harness() {
  let time = 1_000_000;
  const limiter = new IntervalRateLimiter(
    INTERVAL,
    () => time,
    async (ms) => {
      time += ms;
      return true;
    },
  );
  return {
    limiter,
    time: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("given an idle limiter", () => {
  it("when acquiring, then the first caller goes immediately", async () => {
    const { limiter, time } = harness();
    const start = time();

    expect(await limiter.acquire()).toBe(true);

    expect(time()).toBe(start);
  });
});

describe("given a slot was just used", () => {
  it("when acquiring again, then the caller waits a full interval", async () => {
    const { limiter, time } = harness();
    const start = time();
    await limiter.acquire();

    await limiter.acquire();

    expect(time()).toBe(start + INTERVAL);
  });

  it("when part of the interval has passed, then the caller waits only the rest", async () => {
    const { limiter, time, advance } = harness();
    const start = time();
    await limiter.acquire();
    advance(4_000);

    await limiter.acquire();

    expect(time()).toBe(start + INTERVAL);
  });

  it("when the interval has already passed, then the caller goes immediately", async () => {
    const { limiter, time, advance } = harness();
    await limiter.acquire();
    advance(INTERVAL + 1);
    const before = time();

    await limiter.acquire();

    expect(time()).toBe(before);
  });
});

describe("given several concurrent callers", () => {
  it("when they acquire together, then each gets its own slot", async () => {
    // Fake timers here, because callers must wake at their own time for the order to mean anything.
    vi.useFakeTimers();
    try {
      const limiter = new IntervalRateLimiter(
        INTERVAL,
        () => Date.now(),
        (ms) => new Promise((resolve) => setTimeout(() => resolve(true), ms)),
      );
      const start = Date.now();
      const granted: number[] = [];

      const callers = Promise.all(
        [1, 2, 3, 4].map(async () => {
          await limiter.acquire();
          granted.push(Date.now() - start);
        }),
      );
      await vi.runAllTimersAsync();
      await callers;

      expect(granted).toEqual([0, INTERVAL, INTERVAL * 2, INTERVAL * 3]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("given the upstream asked for more time", () => {
  it("when deferring beyond the next slot, then the caller waits for the longer time", async () => {
    const { limiter, time } = harness();
    const start = time();
    await limiter.acquire();
    limiter.defer(25_000);

    await limiter.acquire();

    expect(time()).toBe(start + 25_000);
  });

  it("when deferring less than the interval, then the interval still applies", async () => {
    const { limiter, time } = harness();
    const start = time();
    await limiter.acquire();
    limiter.defer(1_000);

    await limiter.acquire();

    expect(time()).toBe(start + INTERVAL);
  });
});

describe("given the caller is aborted", () => {
  it("when already aborted, then acquire returns false without taking the slot", async () => {
    const { limiter, time } = harness();
    const start = time();

    expect(await limiter.acquire(AbortSignal.abort())).toBe(false);
    expect(await limiter.acquire()).toBe(true);

    expect(time()).toBe(start);
  });

  it("when aborted during the wait, then acquire returns false", async () => {
    const limiter = new IntervalRateLimiter(INTERVAL, () => 1_000_000, async () => false);
    await limiter.acquire();

    expect(await limiter.acquire()).toBe(false);
  });
});
