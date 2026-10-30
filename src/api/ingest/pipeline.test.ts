import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { RawRecord, StreamEvent } from "../../shared/wire.js";
import type { AnalyticsEvent } from "../upstream/schemas.js";
import { runPipeline, type AnalyticsSink, type Enricher } from "./pipeline.js";

const details = { asn: "AS8291", category: "T1566" as const, correlationId: 2318 };

const record = (line: number, overrides: Partial<RawRecord> = {}): RawRecord => ({
  line,
  id: String(1000 + line),
  asset: "server_a",
  ip: "1.2.3.4",
  category: "phising",
  ...overrides,
});
const records = (count: number) => Array.from({ length: count }, (_, i) => record(i + 2));

const enrichOk: Enricher = { enrich: async () => ({ ok: true, value: details, attempts: 1 }) };

function recordingSink(): AnalyticsSink & { batches: AnalyticsEvent[][] } {
  const batches: AnalyticsEvent[][] = [];
  return {
    batches,
    send: async (events) => {
      batches.push(events);
      return { ok: true, value: { status: "ok", itemsIngested: events.length }, attempts: 1 };
    },
  };
}

async function run(
  input: RawRecord[],
  { enricher = enrichOk, sink = recordingSink() as AnalyticsSink, signal = new AbortController().signal } = {},
) {
  const events: StreamEvent[] = [];
  const summary = await runPipeline(
    input,
    { enricher, sink, batchSize: 20, logger: pino({ level: "silent" }) },
    (event) => events.push(event),
    signal,
  );
  return { events, summary, ofType: (type: StreamEvent["type"]) => events.filter((e) => e.type === type) };
}

describe("given valid records", () => {
  it("when the run succeeds, then every record is enriched, sent and counted", async () => {
    const sink = recordingSink();

    const { summary, ofType } = await run(records(3), { sink });

    expect(summary).toEqual({
      received: 3,
      rejected: 0,
      idConflicts: 0,
      enrichmentFailed: 0,
      sent: 3,
      ingested: 3,
      analyticsFailed: 0,
    });
    expect(ofType("enriched")).toHaveLength(3);
    expect(ofType("batch_sent")).toHaveLength(1);
  });

  it("when building the analytics event, then enrichment replaces the category and adds its fields", async () => {
    const sink = recordingSink();

    await run([record(2)], { sink });

    expect(sink.batches[0]).toEqual([
      { id: 1002, asset: "server_a", ip: "1.2.3.4", category: "T1566", asn: "AS8291", correlationId: 2318 },
    ]);
  });

  it("when the run finishes, then the summary is the last event", async () => {
    const { events } = await run(records(2));

    expect(events.at(-1)?.type).toBe("summary");
  });

  it.each([
    [0, []],
    [20, [20]],
    [21, [20, 1]],
    [45, [20, 20, 5]],
  ])("when there are %i records, then the batches are %j", async (count, sizes) => {
    const sink = recordingSink();

    await run(records(count), { sink });

    expect(sink.batches.map((b) => b.length)).toEqual(sizes);
  });
});

describe("given more records than fit in one batch", () => {
  it("when running, then a group is sent before the next one starts enriching", async () => {
    const steps: string[] = [];
    const enricher: Enricher = {
      enrich: async () => {
        steps.push("enrich");
        return { ok: true, value: details, attempts: 1 };
      },
    };
    const sink: AnalyticsSink = {
      send: async (events) => {
        steps.push("send");
        return { ok: true, value: { status: "ok", itemsIngested: events.length }, attempts: 1 };
      },
    };

    await run(records(21), { enricher, sink });

    expect(steps).toEqual([...Array<string>(20).fill("enrich"), "send", "enrich", "send"]);
  });
});

describe("given enrichment fails for a whole group", () => {
  it("when running, then nothing is sent for it and the run carries on", async () => {
    const send = vi.fn<AnalyticsSink["send"]>();
    const enricher: Enricher = { enrich: async () => ({ ok: false, reason: "enrichment unavailable", attempts: 5 }) };

    const { summary } = await run(records(3), { enricher, sink: { send } });

    expect(send).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ enrichmentFailed: 3, sent: 0 });
  });
});

describe("given invalid records", () => {
  it("when validating, then they are rejected with a reason and never enriched", async () => {
    const enrich = vi.fn(enrichOk.enrich);
    const input = [record(2), record(3, { ip: "N" }), record(4, { category: "" })];

    const { summary, ofType } = await run(input, { enricher: { enrich } });

    expect(enrich).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ received: 3, rejected: 2, sent: 1 });
    expect(ofType("rejected")).toEqual([
      { type: "rejected", line: 3, reason: "invalid ip" },
      { type: "rejected", line: 4, reason: "empty category" },
    ]);
  });
});

describe("given a repeated id", () => {
  it("when validating, then both records are sent and the repeat is flagged", async () => {
    const sink = recordingSink();
    const input = [record(2, { id: "517009" }), record(3, { id: "517009", ip: "5.6.7.8" })];

    const { summary, ofType } = await run(input, { sink });

    expect(sink.batches.flat()).toHaveLength(2);
    expect(summary).toMatchObject({ idConflicts: 1, sent: 2 });
    expect(ofType("id_conflict")).toEqual([{ type: "id_conflict", line: 3 }]);
  });
});

describe("given enrichment fails for one record", () => {
  const enricher: Enricher = {
    enrich: async ({ id }) =>
      id === 1003
        ? { ok: false, reason: "enrichment unavailable", attempts: 5 }
        : { ok: true, value: details, attempts: 1 },
  };

  it("when running, then only that record is left out and it is reported", async () => {
    const sink = recordingSink();

    const { summary, ofType } = await run(records(3), { enricher, sink });

    expect(sink.batches.flat().map((e) => e.id).sort()).toEqual([1002, 1004]);
    expect(summary).toMatchObject({ enrichmentFailed: 1, sent: 2 });
    expect(ofType("enrichment_failed")).toEqual([
      { type: "enrichment_failed", line: 3, reason: "enrichment unavailable" },
    ]);
  });
});

describe("given analytics fails for one batch", () => {
  it("when running, then the failure is reported and later batches are still sent", async () => {
    const send = vi
      .fn<AnalyticsSink["send"]>()
      .mockResolvedValueOnce({ ok: false, reason: "analytics unavailable", attempts: 3 })
      .mockResolvedValueOnce({ ok: true, value: { status: "ok", itemsIngested: 5 }, attempts: 1 });

    const { summary, ofType } = await run(records(25), { sink: { send } });

    expect(send).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ analyticsFailed: 20, sent: 5, ingested: 5 });
    expect(ofType("batch_failed")).toHaveLength(1);
  });
});

describe("given analytics stores only part of a batch", () => {
  it("when running, then the summary shows fewer ingested than sent", async () => {
    const sink: AnalyticsSink = {
      send: async () => ({ ok: true, value: { status: "ok", itemsIngested: 2 }, attempts: 1 }),
    };

    const { summary, ofType } = await run(records(3), { sink });

    expect(summary).toMatchObject({ sent: 3, ingested: 2 });
    expect(ofType("batch_sent")).toEqual([{ type: "batch_sent", lines: expect.any(Array), ingested: 2 }]);
  });
});

describe("given a mix of every outcome", () => {
  it("when the run finishes, then every record is in exactly one counter", async () => {
    const enricher: Enricher = {
      enrich: async ({ id }) =>
        id % 7 === 0 ? { ok: false, reason: "enrichment unavailable", attempts: 5 } : { ok: true, value: details, attempts: 1 },
    };
    let call = 0;
    const sink: AnalyticsSink = {
      send: async (events) =>
        ++call === 2
          ? { ok: false, reason: "analytics unavailable", attempts: 3 }
          : { ok: true, value: { status: "ok", itemsIngested: events.length }, attempts: 1 },
    };
    const input = records(100).map((r) => (r.line % 11 === 0 ? { ...r, ip: "N" } : r));

    const { summary } = await run(input, { enricher, sink });

    expect(summary).toBeDefined();
    const { received, rejected, enrichmentFailed, sent, analyticsFailed } = summary!;
    expect(rejected + enrichmentFailed + sent + analyticsFailed).toBe(received);
    expect(rejected).toBeGreaterThan(0);
    expect(enrichmentFailed).toBeGreaterThan(0);
    expect(analyticsFailed).toBeGreaterThan(0);
  });
});

describe("given the API key is rejected", () => {
  it("when enrichment rejects it, then the run stops with one clear error and sends nothing", async () => {
    const enrich = vi.fn<Enricher["enrich"]>(async () => ({
      ok: false,
      reason: "enrichment rejected the API key",
      fatal: true,
      attempts: 1,
    }));
    const send = vi.fn<AnalyticsSink["send"]>();

    const { summary, events, ofType } = await run(records(60), { enricher: { enrich }, sink: { send } });

    expect(enrich).toHaveBeenCalledTimes(20);
    expect(send).not.toHaveBeenCalled();
    expect(summary).toBeUndefined();
    expect(ofType("enrichment_failed")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "run_failed", reason: "enrichment rejected the API key" });
  });

  it("when analytics rejects it, then the run stops without trying more batches", async () => {
    const send = vi.fn<AnalyticsSink["send"]>(async () => ({
      ok: false,
      reason: "analytics rejected the API key",
      fatal: true,
      attempts: 1,
    }));

    const { summary, events, ofType } = await run(records(60), { sink: { send } });

    expect(send).toHaveBeenCalledTimes(1);
    expect(summary).toBeUndefined();
    expect(ofType("batch_failed")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "run_failed", reason: "analytics rejected the API key" });
  });
});

describe("given the client disconnects", () => {
  it("when aborted during a batch, then no more batches are sent and no summary is emitted", async () => {
    const controller = new AbortController();
    const send = vi.fn<AnalyticsSink["send"]>(async (events) => {
      controller.abort();
      return { ok: true, value: { status: "ok", itemsIngested: events.length }, attempts: 1 };
    });

    const { summary, ofType } = await run(records(60), { sink: { send }, signal: controller.signal });

    expect(send).toHaveBeenCalledTimes(1);
    expect(summary).toBeUndefined();
    expect(ofType("summary")).toEqual([]);
  });

  it("when already aborted, then nothing is sent", async () => {
    const send = vi.fn<AnalyticsSink["send"]>();

    const { summary } = await run(records(3), { sink: { send }, signal: AbortSignal.abort() });

    expect(send).not.toHaveBeenCalled();
    expect(summary).toBeUndefined();
  });

  it("when an enrichment call is cut short, then it isn't counted as a failure", async () => {
    const controller = new AbortController();
    const enricher: Enricher = {
      enrich: async () => {
        controller.abort();
        return { ok: false, reason: "aborted", attempts: 1 };
      },
    };

    const { ofType } = await run(records(3), { enricher, signal: controller.signal });

    expect(ofType("enrichment_failed")).toEqual([]);
  });
});
