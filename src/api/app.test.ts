import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { type RawRecord, type StreamEvent, streamEventSchema } from "../shared/wire.js";
import { type AppDeps, createApp } from "./app.js";
import type { AnalyticsSink, Enricher } from "./ingest/pipeline.js";

const details = { asn: "AS8291", category: "T1566" as const, correlationId: 2318 };
const enricher: Enricher = { enrich: async () => ({ ok: true, value: details, attempts: 1 }) };
const sink: AnalyticsSink = {
  send: async (events) => ({ ok: true, value: { status: "ok", itemsIngested: events.length }, attempts: 1 }),
};

const shutdown = new AbortController().signal;

const record = (line: number): RawRecord => ({
  line,
  id: String(line),
  asset: "server_a",
  ip: "1.2.3.4",
  category: "phishing",
});

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    pipeline: { enricher, sink, batchSize: 20, shutdown },
    maxRecordsPerRequest: 10,
    heartbeatIntervalMs: 60_000,
    logger: pino({ level: "silent" }),
    ...overrides,
  });
}

const post = (body: string) =>
  new Request("http://test/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body });

async function readEvents(response: Response): Promise<StreamEvent[]> {
  const lines = (await response.text()).split("\n").filter(Boolean);
  return lines.map((line) => streamEventSchema.parse(JSON.parse(line)));
}

describe("POST /ingest", () => {
  it.each([
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
    ["the wrong shape", JSON.stringify({ rows: [] })],
    ["a record with a missing field", JSON.stringify({ records: [{ line: 2, id: "1" }] })],
  ])("answers 400 to %s", async (_name, body) => {
    const response = await app().request(post(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request body" });
  });

  it("answers 413 above the record limit", async () => {
    const records = Array.from({ length: 11 }, (_, i) => record(i + 2));

    const response = await app().request(post(JSON.stringify({ records })));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too many records" });
  });

  it("answers 413 to a body far above the size limit", async () => {
    const response = await app().request(post(JSON.stringify({ records: [], padding: "x".repeat(20_000) })));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
  });

  it("does not offer any other route", async () => {
    const response = await app().request("http://test/ingest");

    expect(response.status).toBe(404);
  });

  it("streams valid NDJSON, starting with started and ending with summary", async () => {
    const response = await app().request(post(JSON.stringify({ records: [record(2), record(3)] })));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const events = await readEvents(response);
    expect(events[0]).toMatchObject({ type: "started", total: 2 });
    expect(events.at(-1)).toMatchObject({ type: "summary", summary: { received: 2, sent: 2, ingested: 2 } });
  });

  it("gives each run its own id", async () => {
    const ids = await Promise.all(
      [1, 2].map(async () => {
        const events = await readEvents(await app().request(post(JSON.stringify({ records: [] }))));
        return events[0]?.type === "started" ? events[0].runId : undefined;
      }),
    );

    expect(ids[0]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  describe("given analytics takes longer than the heartbeat interval", () => {
    it("when waiting, then heartbeats are written to the stream", async () => {
      const slowSink: AnalyticsSink = {
        send: async (events) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { ok: true, value: { status: "ok", itemsIngested: events.length }, attempts: 1 };
        },
      };

      const response = await app({
        pipeline: { enricher, sink: slowSink, batchSize: 20, shutdown },
        heartbeatIntervalMs: 10,
      }).request(post(JSON.stringify({ records: [record(2)] })));

      const events = await readEvents(response);
      expect(events.filter((e) => e.type === "heartbeat").length).toBeGreaterThan(0);
      expect(events.at(-1)?.type).toBe("summary");
    });
  });

  describe("given the pipeline crashes", () => {
    it("when streaming, then the stream ends with no summary", async () => {
      const crashing: Enricher = {
        enrich: async () => {
          throw new Error("bug");
        },
      };

      const response = await app({
        pipeline: { enricher: crashing, sink, batchSize: 20, shutdown },
      }).request(post(JSON.stringify({ records: [record(2)] })));

      const events = await readEvents(response);
      expect(events.map((e) => e.type)).toEqual(["started"]);
    });
  });

  // Over a real socket, because a dropped connection only shows up there.
  describe("given the client disconnects mid-run", () => {
    it("when the connection closes, then the pipeline is aborted", async () => {
      const aborted = vi.fn();
      let markReached = () => {};
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const blockingSink: AnalyticsSink = {
        send: (_events, signal) =>
          new Promise((resolve) => {
            markReached();
            signal?.addEventListener("abort", () => {
              aborted();
              resolve({ ok: false, reason: "aborted", attempts: 1 });
            });
          }),
      };
      const server = serve({
        fetch: app({ pipeline: { enricher, sink: blockingSink, batchSize: 20, shutdown } }).fetch,
        port: 0,
      });
      await new Promise((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;

      try {
        const client = new AbortController();
        const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
          method: "POST",
          body: JSON.stringify({ records: [record(2)] }),
          signal: client.signal,
        });
        expect(response.status).toBe(200);
        await reached;

        client.abort();

        await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());
      } finally {
        server.close();
      }
    });
  });
});
