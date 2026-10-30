import { describe, expect, it } from "vitest";
import { ingestRequestSchema, streamEventSchema } from "./wire.js";

describe("ingestRequestSchema", () => {
  const record = { line: 2, id: "119611", asset: "server_horizon", ip: "1.2.3.4", category: "phising" };

  it("accepts records whose content is still unvalidated", () => {
    const bad = { ...record, id: "not-a-number", ip: "N", category: "" };
    expect(ingestRequestSchema.safeParse({ records: [record, bad] }).success).toBe(true);
  });

  it.each([
    ["missing records", {}],
    ["records not an array", { records: "x" }],
    ["a missing field", { records: [{ line: 2, id: "1", asset: "a", ip: "1.2.3.4" }] }],
    ["a non-string field", { records: [{ ...record, id: 119611 }] }],
    ["a zero line number", { records: [{ ...record, line: 0 }] }],
  ])("rejects %s", (_name, body) => {
    expect(ingestRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("streamEventSchema", () => {
  it.each([
    { type: "started", runId: "r1", total: 2 },
    { type: "heartbeat" },
    { type: "rejected", line: 2, reason: "invalid ip" },
    { type: "id_conflict", line: 2 },
    { type: "enriched", line: 2 },
    { type: "enrichment_failed", line: 2, reason: "upstream unavailable" },
    { type: "batch_sent", lines: [2, 3], ingested: 2 },
    { type: "batch_sent", lines: [2, 3], ingested: 2, possibleDuplicates: true },
    { type: "batch_failed", lines: [2, 3], reason: "analytics rejected the batch" },
    { type: "run_failed", reason: "enrichment rejected the API key" },
    {
      type: "summary",
      summary: {
        received: 2,
        rejected: 0,
        idConflicts: 0,
        enrichmentFailed: 0,
        sent: 2,
        ingested: 2,
        analyticsFailed: 0,
        possibleDuplicates: 0,
      },
    },
  ])("accepts $type", (event) => {
    expect(streamEventSchema.parse(event)).toEqual(event);
  });

  it.each([{ type: "nope" }, { type: "rejected", line: 2 }, { type: "summary", summary: {} }, {}])(
    "rejects %j",
    (event) => {
      expect(streamEventSchema.safeParse(event).success).toBe(false);
    },
  );
});
