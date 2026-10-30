import { CSV_COLUMNS } from "./read-csv.js";

export interface RejectedRow {
  line: number;
  fields: string[];
  reason: string;
}

// The output of a run is opened in a spreadsheet, and the input is attacker-influenced data.
// A leading quote stops a cell like =HYPERLINK(...) from being run as a formula (CWE-1236).
function neutralise(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

function encode(cell: string): string {
  const safe = neutralise(cell);
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function formatRejects(rows: RejectedRow[]): string {
  const lines = [[...CSV_COLUMNS, "line", "reason"].join(";")];
  for (const { fields, line, reason } of rows) {
    lines.push([...fields, String(line), reason].map(encode).join(";"));
  }
  return `${lines.join("\r\n")}\r\n`;
}
