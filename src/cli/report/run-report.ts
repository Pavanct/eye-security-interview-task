import type { RunSummary, StreamEvent } from "../../shared/wire.js";
import type { IngestOutcome } from "../api/ingest-client.js";

// What the CLI concluded about each row it sent. Anything without an answer at the end of
// a run is reported too, so the user always knows the fate of every row.
export class RunReport {
  private tally: RunSummary;
  private readonly settled = new Set<number>();
  readonly failures = new Map<number, string>();

  constructor(
    private readonly print: (message: string) => void,
    private readonly sentLines: number[],
  ) {
    this.tally = {
      received: sentLines.length,
      rejected: 0,
      idConflicts: 0,
      enrichmentFailed: 0,
      sent: 0,
      ingested: 0,
      analyticsFailed: 0,
      possibleDuplicates: 0,
    };
  }

  handle(event: StreamEvent): void {
    switch (event.type) {
      case "started":
        this.print(`Run ${event.runId}: sending ${event.total} rows. The rate limit means this can take minutes.`);
        break;
      case "rejected":
        this.tally.rejected++;
        this.fail(event.line, event.reason);
        this.print(`Line ${event.line} rejected: ${event.reason}`);
        break;
      case "id_conflict":
        this.tally.idConflicts++;
        this.print(`Line ${event.line}: repeated id, sent anyway`);
        break;
      case "enrichment_failed":
        this.tally.enrichmentFailed++;
        this.fail(event.line, event.reason);
        this.print(`Line ${event.line} failed: ${event.reason}`);
        break;
      case "batch_sent":
        this.tally.sent += event.lines.length;
        this.tally.ingested += event.ingested;
        if (event.ingested !== event.lines.length) {
          // The response doesn't say which were stored, so all of them need checking.
          const reason = `only ${event.ingested} of ${event.lines.length} in this batch were stored, unknown which`;
          this.failAll(event.lines, reason);
          this.print(`Warning: ${reason}`);
        } else if (event.possibleDuplicates) {
          this.tally.possibleDuplicates += event.lines.length;
          const reason = "stored, but possibly twice: an earlier attempt had an unclear result";
          this.failAll(event.lines, reason);
          this.print(`Warning: a batch of ${event.lines.length} was ${reason}`);
        } else {
          for (const line of event.lines) this.settled.add(line);
        }
        this.print(`Stored ${this.tally.ingested} of ${this.expectedToStore} rows`);
        break;
      case "batch_failed":
        this.tally.analyticsFailed += event.lines.length;
        this.failAll(event.lines, event.reason);
        this.print(`A batch of ${event.lines.length} failed: ${event.reason}`);
        break;
      case "summary":
        // The API's own count is the authority for a finished run.
        this.tally = event.summary;
        break;
      case "enriched":
      case "heartbeat":
      case "run_failed":
        break;
    }
  }

  private get expectedToStore(): number {
    const { received, rejected, enrichmentFailed, analyticsFailed } = this.tally;
    return received - rejected - enrichmentFailed - analyticsFailed;
  }

  private failAll(lines: number[], reason: string): void {
    for (const line of lines) this.fail(line, reason);
  }

  private fail(line: number, reason: string): void {
    this.settled.add(line);
    this.failures.set(line, reason);
  }

  // Marks rows with no answer. If the API never took the request, they're safe to resend.
  // Otherwise they may or may not be stored: the connection could have dropped after a
  // batch went out, so rerunning them can create duplicates.
  finish(outcome: IngestOutcome): void {
    if (outcome.kind === "finished") return;
    const neverStarted = outcome.kind === "http_error" || outcome.kind === "unreachable";
    const reason = neverStarted
      ? "not sent: the API did not take the request"
      : "run did not finish, may already be stored";
    for (const line of this.sentLines) {
      if (!this.settled.has(line)) this.failures.set(line, reason);
    }
  }

  get summary(): RunSummary {
    return this.tally;
  }
}

export function describeOutcome(outcome: IngestOutcome): string {
  switch (outcome.kind) {
    case "finished":
      return "Run finished.";
    case "stopped":
      return `Run stopped by the API: ${outcome.reason}.`;
    case "http_error":
      return `The API refused the request (${outcome.status}): ${outcome.message}.`;
    case "unreachable":
      return "Could not reach the API. Is it running, and is --api-url correct?";
    case "stream_ended":
      return "The connection ended before the run finished. The run is incomplete.";
    case "timed_out":
      return "The API stopped responding. The run is incomplete.";
    case "bad_response":
      return "The API sent a response this CLI doesn't understand. The run is incomplete.";
    case "interrupted":
      return "Interrupted. The API stops once it sees the connection close. The run is incomplete.";
  }
}
