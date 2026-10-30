import type { Logger } from "pino";
import type { RawRecord, RunSummary, StreamEvent } from "../../shared/wire.js";
import type { Result } from "../lib/retry.js";
import type { AnalyticsEvent, AnalyticsResponse, EnrichmentDetails, LogLine } from "../upstream/schemas.js";
import { chunk } from "./chunk.js";
import { validateRecord } from "./validate-record.js";

// Defined here, where they're used, so tests can pass small fakes.
export interface Enricher {
  enrich(logLine: LogLine, signal?: AbortSignal): Promise<Result<EnrichmentDetails> & { attempts: number }>;
}

type SendResult = Result<AnalyticsResponse> & { attempts: number; mayBeDuplicated?: boolean };

export interface AnalyticsSink {
  send(events: AnalyticsEvent[], signal?: AbortSignal): Promise<SendResult>;
}

export interface PipelineDeps {
  enricher: Enricher;
  sink: AnalyticsSink;
  batchSize: number;
  // Fires when the server is shutting down. Separate from a run's own abort signal: the
  // client is still connected, so the run can finish its batch and say why it stopped.
  shutdown: AbortSignal;
  logger: Logger;
}

// What the steps of one run share.
interface Run {
  deps: PipelineDeps;
  emit: (event: StreamEvent) => void;
  signal: AbortSignal;
  summary: RunSummary;
}

interface Enrichable {
  line: number;
  logLine: LogLine;
}

interface EnrichedGroup {
  events: AnalyticsEvent[];
  lines: number[];
  fatalReason?: string;
}

// Validate, then for each group: enrich it, send it. Every record ends up in exactly one
// summary counter: received = rejected + enrichmentFailed + sent + analyticsFailed.
//
// Enrichment works one group at a time because analytics is the bottleneck (one batch
// every 10 s, against about 30 ms per enrichment call). Enriching further ahead wouldn't
// shorten the run, and the group size already caps how many calls a run makes at once.
// The cost: a record that fails enrichment leaves its batch short rather than being replaced.
//
// A rejected API key stops the run at once: every remaining call would fail the same way,
// and one clear error is more useful than a failure per record.
//
// Returns undefined if the run didn't finish, whether stopped or aborted. No summary is
// emitted then, which keeps an unfinished run distinguishable from a finished one.
export async function runPipeline(
  records: RawRecord[],
  deps: PipelineDeps,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<RunSummary | undefined> {
  const { sink, batchSize, shutdown, logger } = deps;
  const summary: RunSummary = {
    received: records.length,
    rejected: 0,
    idConflicts: 0,
    enrichmentFailed: 0,
    sent: 0,
    ingested: 0,
    analyticsFailed: 0,
    possibleDuplicates: 0,
  };
  const run: Run = { deps, emit, signal, summary };

  const stopRun = (reason: string): undefined => {
    logger.error({ reason, summary }, "run stopped");
    emit({ type: "run_failed", reason });
    return undefined;
  };

  for (const group of chunk(validateAll(records, run), batchSize)) {
    if (signal.aborted) break;
    // Only checked between groups, so a batch that has started is never abandoned halfway.
    if (shutdown.aborted) return stopRun("server is shutting down");

    const { events, lines, fatalReason } = await enrichGroup(group, run);
    if (signal.aborted) break;
    if (fatalReason !== undefined) return stopRun(fatalReason);
    if (events.length === 0) continue;

    const result = await sink.send(events, signal);

    // A stored batch is counted even if the client has just gone, so the logs stay accurate.
    if (!result.ok && signal.aborted) break;
    if (!result.ok && result.fatal) return stopRun(result.reason);
    recordSendResult(result, lines, run);
  }

  if (signal.aborted) {
    logger.warn({ summary }, "run aborted");
    return undefined;
  }

  logger.info({ summary }, "run finished");
  emit({ type: "summary", summary });
  return summary;
}

function validateAll(records: RawRecord[], { deps: { logger }, emit, summary }: Run): Enrichable[] {
  const seenIds = new Set<number>();
  const valid: Enrichable[] = [];

  for (const record of records) {
    const result = validateRecord(record);
    if (!result.ok) {
      summary.rejected++;
      logger.warn({ line: result.line, reason: result.reason }, "record rejected");
      emit({ type: "rejected", line: result.line, reason: result.reason });
      continue;
    }

    if (seenIds.has(result.logLine.id)) {
      summary.idConflicts++;
      logger.warn({ line: result.line, id: result.logLine.id }, "repeated id");
      emit({ type: "id_conflict", line: result.line });
    }
    seenIds.add(result.logLine.id);
    valid.push({ line: result.line, logLine: result.logLine });
  }

  return valid;
}

async function enrichGroup(group: Enrichable[], { deps, emit, signal, summary }: Run): Promise<EnrichedGroup> {
  const results = await Promise.all(
    group.map(async ({ line, logLine }) => ({ line, logLine, result: await deps.enricher.enrich(logLine, signal) })),
  );

  const enriched: EnrichedGroup = { events: [], lines: [] };
  // A call cut short by the client leaving isn't a failure of that record.
  if (signal.aborted) return enriched;

  for (const { result } of results) {
    if (!result.ok && result.fatal) return { ...enriched, fatalReason: result.reason };
  }

  for (const { line, logLine, result } of results) {
    if (result.ok) {
      emit({ type: "enriched", line });
      // The enrichment category replaces ours: analytics wants the MITRE handle.
      enriched.events.push({ ...logLine, ...result.value });
      enriched.lines.push(line);
    } else {
      summary.enrichmentFailed++;
      deps.logger.warn({ line, reason: result.reason, attempts: result.attempts }, "enrichment failed");
      emit({ type: "enrichment_failed", line, reason: result.reason });
    }
  }

  return enriched;
}

function recordSendResult(result: SendResult, lines: number[], { deps: { logger }, emit, summary }: Run): void {
  if (!result.ok) {
    summary.analyticsFailed += lines.length;
    logger.error({ reason: result.reason, attempts: result.attempts, lines }, "batch failed");
    emit({ type: "batch_failed", lines, reason: result.reason });
    return;
  }

  const { itemsIngested } = result.value;
  summary.sent += lines.length;
  summary.ingested += itemsIngested;
  if (itemsIngested !== lines.length) {
    // The response doesn't say which items were stored, so this can only be reported per batch.
    logger.warn({ sent: lines.length, ingested: itemsIngested, lines }, "partial ingestion");
  }
  if (result.mayBeDuplicated) {
    summary.possibleDuplicates += lines.length;
    logger.warn({ lines, attempts: result.attempts }, "batch may have been stored twice");
  }
  logger.info({ sent: lines.length, ingested: itemsIngested, attempts: result.attempts }, "batch sent");
  emit({
    type: "batch_sent",
    lines,
    ingested: itemsIngested,
    ...(result.mayBeDuplicated ? { possibleDuplicates: true as const } : {}),
  });
}
