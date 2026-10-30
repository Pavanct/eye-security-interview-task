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

export interface AnalyticsSink {
  send(events: AnalyticsEvent[], signal?: AbortSignal): Promise<Result<AnalyticsResponse> & { attempts: number }>;
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

interface Enrichable {
  line: number;
  logLine: LogLine;
}

// Validate, then for each group: enrich it, send it. Every record ends up in exactly one
// summary counter: received = rejected + enrichmentFailed + sent + analyticsFailed.
//
// Enrichment works one group at a time because analytics is the bottleneck (one batch
// every 10 s, against about 30 ms per enrichment call). Enriching further ahead wouldn't
// shorten the run, and the group size already caps how many calls run at once. The cost:
// a record that fails enrichment leaves its batch short rather than being replaced.
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
  const { enricher, sink, batchSize, shutdown, logger } = deps;
  const summary: RunSummary = {
    received: records.length,
    rejected: 0,
    idConflicts: 0,
    enrichmentFailed: 0,
    sent: 0,
    ingested: 0,
    analyticsFailed: 0,
  };

  const stopRun = (reason: string): undefined => {
    logger.error({ reason, summary }, "run stopped");
    emit({ type: "run_failed", reason });
    return undefined;
  };

  const valid = validateAll(records, summary, deps, emit);

  for (const group of chunk(valid, batchSize)) {
    if (signal.aborted) break;
    // Only checked between groups, so a batch that has started is never abandoned halfway.
    if (shutdown.aborted) return stopRun("server is shutting down");

    const results = await Promise.all(group.map((item) => enricher.enrich(item.logLine, signal)));
    if (signal.aborted) break;

    for (const result of results) {
      if (!result.ok && result.fatal) return stopRun(result.reason);
    }

    const events: AnalyticsEvent[] = [];
    const lines: number[] = [];
    results.forEach((result, index) => {
      const { line, logLine } = group[index]!;
      if (result.ok) {
        emit({ type: "enriched", line });
        // The enrichment category replaces ours: analytics wants the MITRE handle.
        events.push({ ...logLine, ...result.value });
        lines.push(line);
      } else {
        summary.enrichmentFailed++;
        logger.warn({ line, reason: result.reason, attempts: result.attempts }, "enrichment failed");
        emit({ type: "enrichment_failed", line, reason: result.reason });
      }
    });

    if (events.length === 0) continue;

    const result = await sink.send(events, signal);
    if (signal.aborted) break;
    if (!result.ok && result.fatal) return stopRun(result.reason);

    if (result.ok) {
      const { itemsIngested } = result.value;
      summary.sent += events.length;
      summary.ingested += itemsIngested;
      if (itemsIngested !== events.length) {
        // The response doesn't say which items were stored, so this can only be reported per batch.
        logger.warn({ sent: events.length, ingested: itemsIngested, lines }, "partial ingestion");
      }
      logger.info({ sent: events.length, ingested: itemsIngested, attempts: result.attempts }, "batch sent");
      emit({ type: "batch_sent", lines, ingested: itemsIngested });
    } else {
      summary.analyticsFailed += events.length;
      logger.error({ reason: result.reason, attempts: result.attempts, lines }, "batch failed");
      emit({ type: "batch_failed", lines, reason: result.reason });
    }
  }

  if (signal.aborted) {
    logger.warn({ summary }, "run aborted");
    return undefined;
  }

  logger.info({ summary }, "run finished");
  emit({ type: "summary", summary });
  return summary;
}

function validateAll(
  records: RawRecord[],
  summary: RunSummary,
  { logger }: PipelineDeps,
  emit: (event: StreamEvent) => void,
): Enrichable[] {
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
