import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const required = { UPSTREAM_API_KEY: "test-key" };

describe("loadConfig", () => {
  it("applies the defaults", () => {
    const config = loadConfig(required);

    expect(config.port).toBe(3000);
    expect(config.upstream).toEqual({ baseUrl: "https://api.heyering.com", apiKey: "test-key" });
    expect(config.enrichment.retry.maxAttempts).toBe(5);
    expect(config.analytics).toEqual({ batchSize: 20, intervalMs: 10_500, timeoutMs: 10_000, maxAttempts: 3 });
    expect(config.maxRecordsPerRequest).toBe(5000);
    expect(config.shutdownGraceMs).toBe(30_000);
  });

  it("reads overrides from strings", () => {
    const config = loadConfig({ ...required, PORT: "8080", ENRICHMENT_MAX_ATTEMPTS: "10", ANALYTICS_BATCH_SIZE: "5" });

    expect(config.port).toBe(8080);
    expect(config.enrichment.retry.maxAttempts).toBe(10);
    expect(config.analytics.batchSize).toBe(5);
  });

  it.each([
    ["a missing API key", {}, "UPSTREAM_API_KEY"],
    ["an empty API key", { UPSTREAM_API_KEY: "" }, "UPSTREAM_API_KEY"],
    ["a batch above the upstream limit", { ...required, ANALYTICS_BATCH_SIZE: "21" }, "ANALYTICS_BATCH_SIZE"],
    ["zero enrichment attempts", { ...required, ENRICHMENT_MAX_ATTEMPTS: "0" }, "ENRICHMENT_MAX_ATTEMPTS"],
    ["a non-numeric interval", { ...required, ANALYTICS_INTERVAL_MS: "soon" }, "ANALYTICS_INTERVAL_MS"],
    ["an invalid base URL", { ...required, UPSTREAM_BASE_URL: "not a url" }, "UPSTREAM_BASE_URL"],
  ])("rejects %s", (_name, env, variable) => {
    expect(() => loadConfig(env)).toThrow(variable);
  });

  it("does not put values in the error message", () => {
    expect(() => loadConfig({ UPSTREAM_API_KEY: "s3cret", PORT: "not-a-port" })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining("s3cret") }),
    );
  });
});
