import { z } from "zod";

// The contract between the CLI and the API.

// Every field is an unvalidated string on purpose. Checking content here would turn
// one bad row into a 400 for the whole file; instead the API validates each record
// and reports the bad ones individually.
export const rawRecordSchema = z.object({
  // Line number in the source file, so a reject can point back at the original row.
  line: z.int().positive(),
  id: z.string(),
  asset: z.string(),
  ip: z.string(),
  category: z.string(),
});
export type RawRecord = z.infer<typeof rawRecordSchema>;

export const ingestRequestSchema = z.object({
  records: z.array(rawRecordSchema),
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const runSummarySchema = z.object({
  received: z.int().nonnegative(),
  rejected: z.int().nonnegative(),
  idConflicts: z.int().nonnegative(),
  enrichmentFailed: z.int().nonnegative(),
  sent: z.int().nonnegative(),
  ingested: z.int().nonnegative(),
  analyticsFailed: z.int().nonnegative(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

// Reasons are fixed strings chosen by the API and never echo raw input, so a
// malicious CSV value can't end up in a terminal or a log through this stream.
const reasonSchema = z.string();

// One JSON object per line of the response. A finished run ends with `summary`. A run
// that had to stop ends with `run_failed`. If the stream ends with neither, the
// connection or the server died, and the CLI knows the run did not finish.
export const streamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), runId: z.string(), total: z.int().nonnegative() }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("rejected"), line: z.int().positive(), reason: reasonSchema }),
  // A repeated id is flagged but still sent. The API doesn't see every CSV column, so
  // it can't prove two rows are the same event, and dropping evidence is the worse error.
  z.object({ type: z.literal("id_conflict"), line: z.int().positive() }),
  z.object({ type: z.literal("enriched"), line: z.int().positive() }),
  z.object({ type: z.literal("enrichment_failed"), line: z.int().positive(), reason: reasonSchema }),
  z.object({
    type: z.literal("batch_sent"),
    lines: z.array(z.int().positive()),
    ingested: z.int().nonnegative(),
  }),
  z.object({
    type: z.literal("batch_failed"),
    lines: z.array(z.int().positive()),
    reason: reasonSchema,
  }),
  z.object({ type: z.literal("run_failed"), reason: reasonSchema }),
  z.object({ type: z.literal("summary"), summary: runSummarySchema }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;
