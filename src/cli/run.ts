import { constants } from "node:fs";
import { access, appendFile, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RawRecord } from "../shared/wire.js";
import { type IngestDeps, postIngest } from "./api/ingest-client.js";
import { type CsvRow, parseCsv } from "./csv/read-csv.js";
import { formatRejects, type RejectedRow } from "./csv/write-rejects.js";
import { UsageError } from "./errors.js";
import { buildFilter, type FilterFlags } from "./filter/filter.js";
import { describeOutcome, RunReport } from "./report/run-report.js";

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

// Checked before anything is sent: finding out after the rows are stored would mean
// losing the list of rows that need attention.
async function assertCanWriteRejects({ file, rejectsPath }: RunOptions): Promise<void> {
  // The input is often the only copy of this data, so it must never be overwritten.
  if (resolve(file) === resolve(rejectsPath)) {
    throw new UsageError("--rejects must not be the input file.");
  }
  const canAccess = (path: string, mode?: number) =>
    access(path, mode).then(
      () => true,
      () => false,
    );
  const target = (await canAccess(rejectsPath)) ? rejectsPath : dirname(rejectsPath);
  if (!(await canAccess(target, constants.W_OK))) {
    throw new UsageError(`Can't write the rejects file to ${rejectsPath}.`);
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
  await assertCanWriteRejects(options);
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
    print(`Possible duplicates: ${s.possibleDuplicates}`);
    print(`Repeated ids:        ${s.idConflicts}`);
  };

  const writeRejects = async () => {
    if (rejects.length === 0) return;
    rejects.sort((a, b) => a.line - b.line);
    try {
      // Appended, so a rerun can't wipe out what an earlier run reported. The cost is that
      // a row rejected twice is listed twice.
      const isNewFile = await stat(options.rejectsPath).then(
        ({ size }) => size === 0,
        () => true,
      );
      await appendFile(options.rejectsPath, formatRejects(rejects, { header: isNewFile }));
      print(`Rows needing attention: ${rejects.length}, added to ${options.rejectsPath}`);
    } catch {
      // The path was fine at the start, but the disk may be full or the path may be a
      // folder. Rows are already stored, so the list still has to reach the user.
      print(`Could not write ${options.rejectsPath}. Rows needing attention: ${rejects.length}`);
      for (const { line, reason } of rejects) print(`Line ${line}: ${reason}`);
    }
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

  const report = new RunReport(
    print,
    records.map((record) => record.line),
  );
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
