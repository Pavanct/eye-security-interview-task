import { describe, expect, it, vi } from "vitest";
import { HttpEnricher } from "./enrichment-client.js";
import type { LogLine } from "./schemas.js";

const logLine: LogLine = { id: 1, asset: "server_a", ip: "1.2.3.4", category: "phishing" };
const details = { asn: "AS8291", category: "T1566", correlationId: 2318 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function enricher(fetchFn: typeof fetch, maxAttempts = 3) {
  return new HttpEnricher(
    { baseUrl: "https://upstream.test", apiKey: "test-key", fetch: fetchFn },
    1000,
    { maxAttempts, baseDelayMs: 1, maxDelayMs: 1 },
    { sleep: async () => true, random: () => 0 },
  );
}

describe("HttpEnricher", () => {
  it("posts the log line with the API key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json(details));

    await enricher(fetchFn).enrich(logLine);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://upstream.test/enrichment");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "test-key" });
    expect(JSON.parse(String(init?.body))).toEqual(logLine);
  });

  it("returns the parsed details on a 200", async () => {
    const result = await enricher(async () => json(details)).enrich(logLine);

    expect(result).toEqual({ ok: true, value: details, attempts: 1 });
  });

  describe("given the service fails intermittently", () => {
    it("when a later attempt succeeds, then the record is enriched", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ error: "internal server error" }, 500))
        .mockResolvedValueOnce(json({ error: "internal server error" }, 500))
        .mockResolvedValueOnce(json(details));

      const result = await enricher(fetchFn).enrich(logLine);

      expect(result).toEqual({ ok: true, value: details, attempts: 3 });
    });

    it("when every attempt fails, then it reports the failure", async () => {
      const fetchFn = vi.fn<typeof fetch>(async () => json({}, 500));

      const result = await enricher(fetchFn).enrich(logLine);

      expect(result).toEqual({ ok: false, reason: "enrichment unavailable", attempts: 3 });
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  it.each([
    ["a 500", async () => json({}, 500), "enrichment unavailable"],
    ["a 503", async () => json({}, 503), "enrichment unavailable"],
    ["a 429", async () => json({}, 429), "enrichment unavailable"],
    ["a 200 with a missing field", async () => json({ asn: "AS1" }), "enrichment returned an invalid response"],
    [
      "a 200 with an unknown technique",
      async () => json({ ...details, category: "T9" }),
      "enrichment returned an invalid response",
    ],
    ["a 200 that isn't JSON", async () => new Response("<html>"), "enrichment returned an invalid response"],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed");
      },
      "enrichment unreachable",
    ],
  ] as Array<[string, typeof fetch, string]>)("retries %s", async (_name, fetchFn, reason) => {
    const spy = vi.fn(fetchFn);

    const result = await enricher(spy).enrich(logLine);

    expect(result).toEqual({ ok: false, reason, attempts: 3 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a 401", 401],
    ["a 403", 403],
  ])("treats %s as fatal, since no record can succeed with a bad key", async (_name, status) => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ error: "api key invalid" }, status));

    const result = await enricher(fetchFn).enrich(logLine);

    expect(result).toEqual({ ok: false, reason: "enrichment rejected the API key", fatal: true, attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 400", 400, "enrichment rejected the record"],
    ["a 404", 404, "enrichment rejected the record"],
  ])("does not retry %s", async (_name, status, reason) => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ error: "nope" }, status));

    const result = await enricher(fetchFn).enrich(logLine);

    expect(result).toEqual({ ok: false, reason, attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries when a call times out", async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      });
    const client = new HttpEnricher(
      { baseUrl: "https://upstream.test", apiKey: "k", fetch: slow },
      5,
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      { sleep: async () => true, random: () => 0 },
    );

    const result = await client.enrich(logLine);

    expect(result).toEqual({ ok: false, reason: "enrichment timed out", attempts: 2 });
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    const result = await enricher(fetchFn).enrich(logLine, controller.signal);

    expect(result).toEqual({ ok: false, reason: "aborted", attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
