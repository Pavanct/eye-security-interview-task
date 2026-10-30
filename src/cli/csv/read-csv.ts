import { parse } from "csv-parse/sync";
import { UsageError } from "../errors.js";

export const CSV_COLUMNS = ["id", "asset_name", "ip", "created_utc", "source", "category"] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

export type CsvRow = { line: number } & Record<CsvColumn, string>;

// A row that can't be read reliably, kept so it can still be reported and fixed.
export interface UnreadableRow {
  line: number;
  fields: string[];
  reason: string;
}

export interface CsvFile {
  rows: CsvRow[];
  unreadable: UnreadableRow[];
}

// Columns are found by name, so their order doesn't matter and extra ones are ignored.
// That also means a rejects file, which adds `line` and `reason`, can be used as input.
export function parseCsv(text: string): CsvFile {
  let parsed: Array<{ record: string[]; info: { lines: number } }>;
  try {
    // The cast is because csv-parse's types don't reflect that `info: true` changes the result.
    parsed = parse(text, {
      delimiter: ";",
      bom: true,
      info: true,
      skip_empty_lines: true,
      // One short row or stray quote must not fail the whole file. Short rows are reported below.
      relax_column_count: true,
      relax_quotes: true,
    }) as unknown as typeof parsed;
  } catch {
    throw new UsageError("The file could not be read as a semicolon-delimited CSV.");
  }

  const header = parsed[0]?.record;
  const missing = CSV_COLUMNS.filter((column) => !header?.includes(column));
  if (!header || missing.length > 0) {
    throw new UsageError(`The file is missing these columns: ${missing.join(", ")}`);
  }

  const positions = CSV_COLUMNS.map((column) => header.indexOf(column));
  const rows: CsvRow[] = [];
  const unreadable: UnreadableRow[] = [];

  for (const { record, info } of parsed.slice(1)) {
    if (record.length !== header.length) {
      unreadable.push({
        line: info.lines,
        // In the standard column order, so the rejects file lines up even for short rows.
        fields: positions.map((position) => record[position] ?? ""),
        reason: `expected ${header.length} fields but found ${record.length}`,
      });
      continue;
    }
    const row = { line: info.lines } as CsvRow;
    for (const column of CSV_COLUMNS) {
      row[column] = record[header.indexOf(column)] ?? "";
    }
    rows.push(row);
  }

  return { rows, unreadable };
}
