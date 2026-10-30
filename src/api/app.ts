import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import type { Logger } from "pino";
import { ingestRequestSchema, type StreamEvent } from "../shared/wire.js";
import { runPipeline, type PipelineDeps } from "./ingest/pipeline.js";

export interface AppDeps {
  pipeline: Omit<PipelineDeps, "logger">;
  maxRecordsPerRequest: number;
  heartbeatIntervalMs: number;
  logger: Logger;
}

// A generous allowance per record. The point is to refuse a huge body before parsing it.
const MAX_BYTES_PER_RECORD = 1024;

export function createApp({ pipeline, maxRecordsPerRequest, heartbeatIntervalMs, logger }: AppDeps): Hono {
  const app = new Hono();

  app.post(
    "/ingest",
    bodyLimit({
      maxSize: maxRecordsPerRequest * MAX_BYTES_PER_RECORD,
      onError: (c) => c.json({ error: "request body too large" }, 413),
    }),
    async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const parsed = ingestRequestSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

      const { records } = parsed.data;
      if (records.length > maxRecordsPerRequest) return c.json({ error: "too many records" }, 413);

      const runId = randomUUID();
      const log = logger.child({ runId });
      log.info({ records: records.length }, "run started");

      c.header("Content-Type", "application/x-ndjson");

      return stream(c, async (output) => {
        const controller = new AbortController();
        output.onAbort(() => controller.abort());

        // Events come from concurrent work, so writes are chained to keep each line whole
        // and in order.
        let writes: Promise<unknown> = Promise.resolve();
        const emit = (event: StreamEvent) => {
          writes = writes.then(() => output.write(`${JSON.stringify(event)}\n`));
        };

        emit({ type: "started", runId, total: records.length });
        const heartbeat = setInterval(() => emit({ type: "heartbeat" }), heartbeatIntervalMs);

        try {
          await runPipeline(records, { ...pipeline, logger: log }, emit, controller.signal);
        } catch (err) {
          // The status line has already gone out, so this can't become an error response.
          // The stream ends with no summary, which the CLI reports as an incomplete run.
          log.error({ err }, "run crashed");
        } finally {
          clearInterval(heartbeat);
          await writes;
        }
      });
    },
  );

  return app;
}
