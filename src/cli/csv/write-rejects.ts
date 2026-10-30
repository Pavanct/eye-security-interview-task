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

// Escape codes in a hostile value could act on the terminal of whoever views this file.
// They're shown as text, so the evidence stays readable. Tabs and line breaks are kept.
function showControlCharacters(cell: string): string {
  return cell.replace(/\p{Cc}/gu, (char) =>
    /[\t\r\n]/.test(char) ? char : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function encode(cell: string): string {
  const safe = neutralise(showControlCharacters(cell));
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

// The header is optional because rows can be appended to a file that already has one.
export function formatRejects(rows: RejectedRow[], { header = true } = {}): string {
  const lines = header ? [[...CSV_COLUMNS, "line", "reason"].join(";")] : [];
  for (const { fields, line, reason } of rows) {
    lines.push([...fields, String(line), reason].map(encode).join(";"));
  }
  return `${lines.join("\r\n")}\r\n`;
}
