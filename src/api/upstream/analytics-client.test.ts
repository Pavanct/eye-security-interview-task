import { describe, expect, it, vi } from "vitest";
import { IntervalRateLimiter } from "../lib/rate-limiter.js";
import { HttpAnalyticsSink } from "./analytics-client.js";
import type { AnalyticsEvent } from "./schemas.js";

const events: AnalyticsEvent[] = [
  { id: 1, asset: "server_a", ip: "1.2.3.4", category: "T1566", asn: "AS8291", correlationId: 2318 },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const okBody = { status: "ok", itemsIngested: 1 };
const INTERVAL = 10_000;

function harness(fetchFn: typeof fetch, maxAttempts = 3) {
  let time = 0;
  const limiter = new IntervalRateLimiter(
    INTERVAL,
    () => time,
    async (ms) => {
      time += ms;
      return true;
    },
  );
  const sink = new HttpAnalyticsSink(
    { baseUrl: "https://upstream.test", apiKey: "test-key", fetch: fetchFn },
    limiter,
    1000,
    maxAttempts,
    { sleep: async () => true, random: () => 0 },
  );
  return { sink, time: () => time };
}

describe("HttpAnalyticsSink", () => {
  it("posts the events as a JSON array with the API key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json(okBody));

    await harness(fetchFn).sink.send(events);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://upstream.test/analytics");
    expect(init?.headers).toMatchObject({ Authorization: "test-key" });
    expect(JSON.parse(String(init?.body))).toEqual(events);
  });

  describe("given two batches", () => {
    it("when sent one after the other, then the second waits for the interval", async () => {
      const { sink, time } = harness(async () => json(okBody));

      await sink.send(events);
      await sink.send(events);

      expect(time()).toBe(INTERVAL);
    });
  });

  describe("given the service answers 429 with an HTML page and Retry-After", () => {
    const limited = () => new Response("<!doctype html>", { status: 429, headers: { "retry-after": "30" } });

    it("when retrying, then it waits as long as the service asked and then succeeds", async () => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(limited()).mockResolvedValueOnce(json(okBody));
      const { sink, time } = harness(fetchFn);

      const result = await sink.send(events);

      expect(result).toEqual({ ok: true, value: okBody, attempts: 2 });
      expect(time()).toBe(30_000);
    });

    it("when it keeps limiting, then the batch fails after the attempts run out", async () => {
      const fetchFn = vi.fn<typeof fetch>(async () => limited());

      const result = await harness(fetchFn).sink.send(events);

      expect(result).toEqual({ ok: false, reason: "analytics rate limited the request", attempts: 3 });
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  describe("given a retry after a failure", () => {
    it("when retrying, then it still goes through the rate limiter", async () => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json(okBody));
      const { sink, time } = harness(fetchFn);

      const result = await sink.send(events);

      expect(result).toEqual({ ok: true, value: okBody, attempts: 2, mayBeDuplicated: true });
      expect(time()).toBe(INTERVAL);
    });
  });

  describe("given an attempt that doesn't say whether the batch was stored", () => {
    it.each([
      ["a 500", async () => json({}, 500)],
      [
        "a network error",
        async () => {
          throw new TypeError("fetch failed");
        },
      ],
    ] as Array<[string, typeof fetch]>)(
      "when %s is followed by a success, then it is flagged as a possible duplicate",
      async (_name, first) => {
        const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(first).mockResolvedValueOnce(json(okBody));

        const result = await harness(fetchFn).sink.send(events);

        expect(result).toEqual({ ok: true, value: okBody, attempts: 2, mayBeDuplicated: true });
      },
    );

    it("when a 429 is followed by a success, then it isn't flagged, because a 429 stores nothing", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("<html>", { status: 429 }))
        .mockResolvedValueOnce(json(okBody));

      const result = await harness(fetchFn).sink.send(events);

      expect(result).toEqual({ ok: true, value: okBody, attempts: 2 });
    });
  });

  it.each([
    ["a 500", async () => json({}, 500), "analytics unavailable, and the batch may already be stored"],
    [
      "a status error with nothing stored",
      async () => json({ status: "error", itemsIngested: 0 }),
      "analytics stored nothing",
    ],
    [
      "a status ok with nothing stored",
      async () => json({ status: "ok", itemsIngested: 0 }),
      "analytics stored nothing",
    ],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed");
      },
      "analytics unreachable, and the batch may already be stored",
    ],
  ] as Array<[string, typeof fetch, string]>)("retries %s", async (_name, fetchFn, reason) => {
    const spy = vi.fn(fetchFn);

    const result = await harness(spy).sink.send(events);

    expect(result).toEqual({ ok: false, reason, attempts: 3 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "a 400",
      async () => json({ error: "input data should have between 1-20 items" }, 400),
      "analytics rejected the batch",
    ],
    [
      "a 200 with an invalid body, as the batch may be stored",
      async () => new Response("<html>"),
      "analytics returned an invalid response",
    ],
    [
      "a 200 claiming more items than were sent",
      async () => json({ status: "ok", itemsIngested: 2 }),
      "analytics returned an invalid response",
    ],
    [
      "a 200 with status error and items stored",
      async () => json({ status: "error", itemsIngested: 1 }),
      "analytics reported an error, and the batch may be partly stored",
    ],
  ] as Array<[string, typeof fetch, string]>)("does not retry %s", async (_name, fetchFn, reason) => {
    const spy = vi.fn(fetchFn);

    const result = await harness(spy).sink.send(events);

    expect(result).toEqual({ ok: false, reason, attempts: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("treats a %i as fatal, since no batch can succeed with a bad key", async (status) => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({}, status));

    const result = await harness(fetchFn).sink.send(events);

    expect(result).toEqual({ ok: false, reason: "analytics rejected the API key", fatal: true, attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  describe("given a 200 that stored only part of the batch", () => {
    it("when it says ok, then it is returned without a retry that would duplicate items", async () => {
      const body = { status: "ok", itemsIngested: 1 };
      const fetchFn = vi.fn<typeof fetch>(async () => json(body));

      const result = await harness(fetchFn).sink.send([...events, ...events]);

      expect(result).toEqual({ ok: true, value: body, attempts: 1 });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it("stops without calling the service when aborted", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json(okBody));

    const result = await harness(fetchFn).sink.send(events, AbortSignal.abort());

    expect(result).toEqual({ ok: false, reason: "aborted", attempts: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
