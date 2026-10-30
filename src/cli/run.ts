import { readFile, writeFile } from "node:fs/promises";
import type { RawRecord } from "../shared/wire.js";
import { postIngest, type IngestDeps } from "./api/ingest-client.js";
import { parseCsv, type CsvRow } from "./csv/read-csv.js";
import { formatRejects, type RejectedRow } from "./csv/write-rejects.js";
import { UsageError } from "./errors.js";
import { buildFilter, type FilterFlags } from "./filter/filter.js";
import { RunReport, describeOutcome } from "./report/run-report.js";

export const EXIT_OK = 0;
export const EXIT_INCOMPLETE = 1;
export const EXIT_USAGE = 2;

export interface RunOptions {
  file: string;
  apiUrl: string;
  rejectsPath: string;
  filter: FilterFlags;
}

const fieldsOf = (row: CsvRow) => [row.id, row.asset_name, row.ip, row.created_utc, row.source, row.category];

async function readInput(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    throw new UsageError(`Could not read ${file}.`);
  }
}

// Reads and filters locally, sends the rest, and accounts for every row in the file.
// The exit code is 0 only if every row that should have been stored was.
export async function runIngest(
  options: RunOptions,
  deps: IngestDeps & { print: (message: string) => void },
): Promise<number> {
  const { print } = deps;
  const filter = buildFilter(options.filter);
  const { rows, unreadable } = parseCsv(await readInput(options.file));

  const rejects: RejectedRow[] = unreadable.map(({ line, fields, reason }) => ({ line, fields, reason }));
  const toSend: CsvRow[] = [];
  let filteredOut = 0;

  for (const row of rows) {
    const decision = filter(row);
    if (decision.kind === "keep") toSend.push(row);
    else if (decision.kind === "drop") filteredOut++;
    else rejects.push({ line: row.line, fields: fieldsOf(row), reason: decision.reason });
  }
  const notSent = rejects.length;

  const printSummary = (report?: RunReport) => {
    print("");
    print(`Rows in file:        ${rows.length + unreadable.length}`);
    print(`Filtered out:        ${filteredOut}`);
    print(`Not sent (see file): ${notSent}`);
    print(`Sent to the API:     ${toSend.length}`);
    if (!report) return;
    const s = report.summary;
    print(`Rejected by the API: ${s.rejected}`);
    print(`Enrichment failed:   ${s.enrichmentFailed}`);
    print(`Analytics failed:    ${s.analyticsFailed}`);
    print(`Stored:              ${s.ingested}`);
    print(`Repeated ids:        ${s.idConflicts}`);
  };

  const writeRejects = async () => {
    if (rejects.length === 0) return;
    await writeFile(options.rejectsPath, formatRejects(rejects.sort((a, b) => a.line - b.line)));
    print(`Rows needing attention: ${rejects.length}, with reasons in ${options.rejectsPath}`);
  };

  if (toSend.length === 0) {
    print("No rows to send.");
    printSummary();
    await writeRejects();
    return rejects.length === 0 ? EXIT_OK : EXIT_INCOMPLETE;
  }

  const records: RawRecord[] = toSend.map((row) => ({
    line: row.line,
    id: row.id,
    asset: row.asset_name,
    ip: row.ip,
    category: row.category,
  }));

  const report = new RunReport(print, records.map((record) => record.line));
  const outcome = await postIngest(options.apiUrl, records, (event) => report.handle(event), deps);
  report.finish(outcome);

  for (const row of toSend) {
    const reason = report.failures.get(row.line);
    if (reason !== undefined) rejects.push({ line: row.line, fields: fieldsOf(row), reason });
  }

  print("");
  print(describeOutcome(outcome));
  printSummary(report);
  await writeRejects();

  return outcome.kind === "finished" && rejects.length === 0 ? EXIT_OK : EXIT_INCOMPLETE;
}
