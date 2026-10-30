import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_KEY, csvRows, HEADER, runFlow } from "./harness.js";

const sample = readFileSync(new URL("../../example_data_2.csv", import.meta.url), "utf8");
const csv = (rows: string[]) => `${[HEADER, ...rows].join("\r\n")}\r\n`;
const rejectLines = (rejects?: string) =>
  (rejects ?? "")
    .trim()
    .split("\r\n")
    .slice(1)
    .map((line) => Number(line.split(";")[6]));

describe("given the sample file and healthy services", () => {
  it("when ingested, then every valid row is stored and every bad row is reported", async () => {
    const { exitCode, output, rejects, upstream } = await runFlow({ csv: sample });

    expect(upstream.stored).toHaveLength(996);
    expect(rejectLines(rejects)).toEqual([105, 436, 675]);
    expect(rejects).toContain("expected 6 fields but found 5");
    expect(rejects).toContain("invalid ip");
    expect(rejects).toContain("empty category");
    expect(output).toMatch(/Stored:\s+996/);
    expect(output).toMatch(/Repeated ids:\s+3/);
    // Three rows need attention, so this isn't reported as a clean success.
    expect(exitCode).toBe(1);
  });

  it("when ingested, then the calls to the services follow their contracts", async () => {
    const { upstream } = await runFlow({ csv: sample });

    expect(upstream.authHeaders).toEqual(new Set([API_KEY]));
    // Nothing the services don't need leaves the system, such as line numbers or sources.
    expect(upstream.bodyKeys).toEqual(new Set(["id", "asset", "ip", "category"]));
    for (const event of upstream.stored) {
      expect(event.category).toMatch(/^T\d{4}$/);
      expect(event.asn).toBe("AS8291");
      expect(event.correlationId).toBe(event.id);
    }
  });

  it("when ingested, then it stays within the rate limit and batch size", async () => {
    const { upstream } = await runFlow({ csv: sample });

    expect(upstream.rateLimited).toBe(0);
    expect(upstream.analyticsCalls).toBe(50);
    upstream.analyticsAt.slice(1).forEach((at, index) => {
      expect(at - upstream.analyticsAt[index]!).toBeGreaterThanOrEqual(15);
    });
  });

  it("when filtered, then only the matching rows reach the services", async () => {
    const { upstream, output } = await runFlow({
      csv: sample,
      filter: { source: ["defender"], category: ["phishing"], from: "01/03/2024", to: "2024-03-31" },
    });

    expect(upstream.stored).toHaveLength(7);
    expect(upstream.enrichmentCalls).toHaveLength(7);
    expect(new Set(upstream.stored.map((e) => e.category))).toEqual(new Set(["T1566"]));
    expect(output).toMatch(/Filtered out:\s+991/);
  });
});

describe("given a clean file and healthy services", () => {
  it("when ingested, then it exits 0 and writes no rejects file", async () => {
    const { exitCode, rejects, upstream } = await runFlow({ csv: csv(csvRows(45)) });

    expect(exitCode).toBe(0);
    expect(rejects).toBeUndefined();
    expect(upstream.stored).toHaveLength(45);
  });
});

describe("given a flaky enrichment service and a rate limit hit", () => {
  it("when each record fails twice and analytics answers 429 once, then nothing is lost", async () => {
    const { exitCode, rejects, upstream } = await runFlow({
      csv: csv(csvRows(25)),
      behaviour: {
        enrichment: (_body, attempt) =>
          attempt <= 2 ? { status: 500, body: JSON.stringify({ error: "internal server error" }) } : undefined,
        analytics: (_events, call) =>
          call === 1
            ? { status: 429, body: "<!doctype html>", headers: { "retry-after": "1", "content-type": "text/html" } }
            : undefined,
      },
    });

    expect(exitCode).toBe(0);
    expect(rejects).toBeUndefined();
    expect(upstream.stored).toHaveLength(25);
    expect(upstream.enrichmentCalls).toHaveLength(75);
  });
});

describe("given analytics stores a batch but answers 500", () => {
  it("when the retry succeeds, then nothing is lost and the possible duplicate is reported", async () => {
    const { exitCode, output, rejects, upstream } = await runFlow({
      csv: csv(csvRows(3)),
      behaviour: { analytics: (_events, call) => (call === 1 ? { status: 500 } : undefined) },
    });

    expect(upstream.analyticsCalls).toBe(2);
    expect(output).toMatch(/Possible duplicates:\s+3/);
    expect(rejects).toContain("stored, but possibly twice");
    expect(exitCode).toBe(1);
  });
});

describe("given enrichment keeps failing for some records", () => {
  it("when ingested, then those are reported and the others are stored", async () => {
    const { exitCode, rejects, upstream } = await runFlow({
      csv: csv(csvRows(25)),
      behaviour: { enrichment: ({ id }) => (id === 7 ? { status: 500, body: "{}" } : undefined) },
    });

    expect(upstream.stored).toHaveLength(24);
    expect(upstream.stored.map((e) => e.id)).not.toContain(7);
    expect(upstream.enrichmentCalls.filter((c) => c.id === 7)).toHaveLength(5);
    expect(rejects).toContain("8;enrichment unavailable");
    expect(exitCode).toBe(1);
  });
});

describe("given the analytics service is down", () => {
  it("when ingested, then attempts are bounded and every row is reported", async () => {
    const { exitCode, rejects, upstream } = await runFlow({
      csv: csv(csvRows(25)),
      behaviour: { analytics: () => ({ status: 503 }) },
    });

    // Two batches with three attempts each.
    expect(upstream.analyticsCalls).toBe(6);
    expect(rejectLines(rejects)).toHaveLength(25);
    expect(rejects).toContain("analytics unavailable");
    expect(exitCode).toBe(1);
  });
});

describe("given a bad API key", () => {
  it("when ingested, then the run stops with a clear message and nothing is stored", async () => {
    const { exitCode, output, upstream } = await runFlow({ csv: csv(csvRows(60)), apiKey: "wrong" });

    expect(output).toContain("enrichment rejected the API key");
    expect(upstream.analyticsCalls).toBe(0);
    // One group, not all 60.
    expect(upstream.unauthorized).toBe(20);
    expect(exitCode).toBe(1);
  });
});

describe("given the API goes away mid-run", () => {
  it("when the connection drops, then the CLI reports an incomplete run and the unconfirmed rows", async () => {
    const { exitCode, output, rejects } = await runFlow({
      csv: csv(csvRows(60)),
      behaviour: {
        analytics: (_events, call, { dropApiConnections }) => {
          if (call === 2) dropApiConnections();
          return undefined;
        },
      },
    });

    expect(output).toContain("The run is incomplete");
    expect(output).not.toContain("Run finished");
    expect(rejects).toContain("run did not finish");
    expect(rejectLines(rejects)).toHaveLength(40);
    expect(exitCode).toBe(1);
  });

  it("when the server shuts down, then the batch finishes and the CLI is told why", async () => {
    const { exitCode, output, rejects, upstream } = await runFlow({
      csv: csv(csvRows(60)),
      behaviour: {
        analytics: (_events, call, { shutdownApi }) => {
          if (call === 1) shutdownApi();
          return undefined;
        },
      },
    });

    expect(upstream.stored).toHaveLength(20);
    expect(output).toContain("server is shutting down");
    expect(rejectLines(rejects)).toHaveLength(40);
    expect(exitCode).toBe(1);
  });
});

describe("given a file of hostile values", () => {
  it("when ingested, then none reach the services and every row is reported", async () => {
    const hostile = [
      `=cmd|' /C calc'!A0;server_a;1.2.3.4;x;y;phishing`,
      `2;<script>alert(1)</script>;1.2.3.4;x;y;phishing`,
      `3;server_a;1.2.3.4'--;x;y;phishing`,
      `4;server_a;1.2.3.4;x;y;\u001b[31mred`,
      `5;server_a;1.2.3.4;x;y;__proto__`,
      `6;"server\n{""level"":60}";1.2.3.4;x;y;phishing`,
      `007;server_a;1.2.3.4;x;y;phishing`,
    ];

    const { exitCode, output, rejects, upstream } = await runFlow({ csv: csv(hostile) });

    expect(upstream.enrichmentCalls).toEqual([]);
    expect(upstream.analyticsCalls).toBe(0);
    expect(output).toMatch(/Rejected by the API:\s+7/);
    expect(output).not.toContain("\u001b");
    expect(rejects).not.toContain("\u001b");
    expect(rejects).toContain("'=cmd");
    expect(exitCode).toBe(1);
  });
});
