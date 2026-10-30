import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../../shared/wire.js";
import { postIngest, readLines, type IngestDeps } from "./ingest-client.js";

const encoder = new TextEncoder();

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const items: string[] = [];
  for await (const item of source) items.push(item);
  return items;
}

async function* chunks(...parts: Array<string | Uint8Array>) {
  for (const part of parts) yield typeof part === "string" ? encoder.encode(part) : part;
}

describe("readLines", () => {
  it.each([
    ["one chunk per line", ["a\n", "b\n"], ["a", "b"]],
    ["several lines in one chunk", ["a\nb\nc\n"], ["a", "b", "c"]],
    ["a line split across chunks", ['{"ty', 'pe":"x"}\n'], ['{"type":"x"}']],
    ["a line split right before its newline", ["a", "\n", "b\n"], ["a", "b"]],
    ["no final newline", ["a\nb"], ["a", "b"]],
    ["empty lines", ["a\n\nb\n\n"], ["a", "b"]],
    ["no data", [], []],
  ])("handles %s", async (_name, parts, expected) => {
    expect(await collect(readLines(chunks(...parts)))).toEqual(expected);
  });

  it("handles a multi-byte character split across chunks", async () => {
    const bytes = encoder.encode("é\n");

    expect(await collect(readLines(chunks(bytes.slice(0, 1), bytes.slice(1))))).toEqual(["é"]);
  });
});

const summary = {
  type: "summary",
  summary: {
    received: 0,
    rejected: 0,
    idConflicts: 0,
    enrichmentFailed: 0,
    sent: 0,
    ingested: 0,
    analyticsFailed: 0,
    possibleDuplicates: 0,
  },
};
const ndjson = (...events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");

async function call(fetchFn: typeof fetch, overrides: Partial<IngestDeps> = {}) {
  const events: StreamEvent[] = [];
  const outcome = await postIngest("http://api.test", [], (e) => events.push(e), {
    fetch: fetchFn,
    signal: new AbortController().signal,
    idleTimeoutMs: 1000,
    ...overrides,
  });
  return { outcome, events };
}

// A response whose body sends these parts and then stays open until the request is aborted.
const hanging = (signal: AbortSignal | null | undefined, ...parts: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    }),
  );

describe("postIngest", () => {
  it("posts the records as JSON to /ingest", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(ndjson(summary)));

    await postIngest(
      "http://api.test",
      [{ line: 2, id: "1", asset: "a", ip: "1.2.3.4", category: "phishing" }],
      () => {},
      { fetch: fetchFn, signal: new AbortController().signal, idleTimeoutMs: 1000 },
    );

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://api.test/ingest");
    expect(JSON.parse(String(init?.body)).records).toHaveLength(1);
  });

  it("passes each event on, and finishes on a summary", async () => {
    const { outcome, events } = await call(async () =>
      new Response(ndjson({ type: "heartbeat" }, { type: "enriched", line: 2 }, summary)),
    );

    expect(outcome).toEqual({ kind: "finished" });
    expect(events.map((e) => e.type)).toEqual(["heartbeat", "enriched", "summary"]);
  });

  it("reports a run the API stopped, with its reason", async () => {
    const { outcome } = await call(async () =>
      new Response(ndjson({ type: "run_failed", reason: "enrichment rejected the API key" })),
    );

    expect(outcome).toEqual({ kind: "stopped", reason: "enrichment rejected the API key" });
  });

  it("treats a stream with no final event as not finished", async () => {
    const { outcome } = await call(async () => new Response(ndjson({ type: "enriched", line: 2 })));

    expect(outcome).toEqual({ kind: "stream_ended" });
  });

  it.each([
    ["a JSON error", new Response(JSON.stringify({ error: "too many records" }), { status: 413 }), "too many records"],
    ["a non-JSON error", new Response("<html>", { status: 502 }), "the API returned an error"],
  ])("reports %s from the API", async (_name, response, message) => {
    const { outcome } = await call(async () => response);

    expect(outcome).toEqual({ kind: "http_error", status: response.status, message });
  });

  it("reports an API it can't reach", async () => {
    const { outcome } = await call(async () => {
      throw new TypeError("fetch failed");
    });

    expect(outcome).toEqual({ kind: "unreachable" });
  });

  it("treats a connection that drops mid-stream as not finished", async () => {
    const dropping = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson({ type: "enriched", line: 2 })));
        },
        pull(controller) {
          controller.error(new Error("socket hang up"));
        },
      }),
    );

    const { outcome, events } = await call(async () => dropping);

    expect(outcome).toEqual({ kind: "stream_ended" });
    expect(events).toHaveLength(1);
  });

  it.each([
    ["a line that isn't JSON", "not json\n"],
    ["an unknown event", ndjson({ type: "surprise" })],
  ])("stops on %s", async (_name, body) => {
    const { outcome } = await call(async () => new Response(body));

    expect(outcome).toEqual({ kind: "bad_response" });
  });

  describe("given the server goes silent", () => {
    it("when nothing arrives within the idle timeout, then it gives up", async () => {
      const { outcome } = await call(async (_url, init) => hanging(init?.signal, ndjson({ type: "heartbeat" })), {
        idleTimeoutMs: 10,
      });

      expect(outcome).toEqual({ kind: "timed_out" });
    });

    it("when the summary has already arrived, then the run still counts as finished", async () => {
      const { outcome } = await call(async (_url, init) => hanging(init?.signal, ndjson(summary)), {
        idleTimeoutMs: 10,
      });

      expect(outcome).toEqual({ kind: "finished" });
    });
  });

  describe("given the user presses Ctrl+C", () => {
    it("when the signal fires, then it reports an interruption", async () => {
      const controller = new AbortController();

      const { outcome } = await call(
        async (_url, init) => {
          setTimeout(() => controller.abort(), 5);
          return hanging(init?.signal, ndjson({ type: "heartbeat" }));
        },
        { signal: controller.signal },
      );

      expect(outcome).toEqual({ kind: "interrupted" });
    });
  });
});
