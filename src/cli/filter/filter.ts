import { DateTime } from "luxon";
import { normaliseCategory } from "../../shared/category/normalise-category.js";
import type { CsvRow } from "../csv/read-csv.js";
import { UsageError } from "../errors.js";

export interface FilterFlags {
  source: string[];
  asset: string[];
  category?: string;
  from?: string;
  to?: string;
}

export type FilterDecision =
  | { kind: "keep" }
  | { kind: "drop" }
  // The row's value can't be compared, so we can't tell if it matches. It's reported
  // rather than dropped, so a row with a bad category doesn't vanish without a trace.
  | { kind: "uncheckable"; reason: string };

type Check = (row: CsvRow) => FilterDecision;

const KEEP: FilterDecision = { kind: "keep" };
const DROP: FilterDecision = { kind: "drop" };

// `new Date("01/02/2024")` reads month-first, but this data is day-first. Luxon with an
// explicit format and zone can't get that wrong, and it rejects dates like 31/02/2024.
function parseFlagDate(flag: string, value: string): DateTime {
  for (const format of ["dd/MM/yyyy", "yyyy-MM-dd"]) {
    const date = DateTime.fromFormat(value, format, { zone: "utc" });
    if (date.isValid) return date;
  }
  throw new UsageError(`--${flag} must be a date like 27/02/2024 or 2024-02-27.`);
}

function oneOf(values: string[], read: (row: CsvRow) => string): Check {
  const allowed = new Set(values.map((value) => value.toLowerCase()));
  return (row) => (allowed.has(read(row).toLowerCase()) ? KEEP : DROP);
}

function categoryIs(flag: string): Check {
  const wanted = normaliseCategory(flag);
  if (!wanted.ok) throw new UsageError(`--category "${flag}" is not a known category.`);

  return (row) => {
    const category = normaliseCategory(row.category);
    if (!category.ok) return { kind: "uncheckable", reason: category.reason };
    return category.category === wanted.category ? KEEP : DROP;
  };
}

function dateWithin(from?: DateTime, to?: DateTime): Check {
  return (row) => {
    const created = DateTime.fromFormat(row.created_utc, "dd/MM/yyyy HH:mm", { zone: "utc" });
    if (!created.isValid) return { kind: "uncheckable", reason: "invalid created_utc" };
    if (from && created < from) return DROP;
    if (to && created > to) return DROP;
    return KEEP;
  };
}

// Validates the flags up front, so a typo fails before anything is read or sent.
// Different flags combine with AND. A repeated flag means OR.
export function buildFilter(flags: FilterFlags): Check {
  const checks: Check[] = [];

  if (flags.source.length > 0) checks.push(oneOf(flags.source, (row) => row.source));
  if (flags.asset.length > 0) checks.push(oneOf(flags.asset, (row) => row.asset_name));
  if (flags.category !== undefined) checks.push(categoryIs(flags.category));

  if (flags.from !== undefined || flags.to !== undefined) {
    const from = flags.from === undefined ? undefined : parseFlagDate("from", flags.from).startOf("day");
    const to = flags.to === undefined ? undefined : parseFlagDate("to", flags.to).endOf("day");
    if (from && to && from > to) throw new UsageError("--from must not be later than --to.");
    checks.push(dateWithin(from, to));
  }

  return (row) => {
    let uncheckable: FilterDecision | undefined;
    for (const check of checks) {
      const decision = check(row);
      // A clear mismatch on any flag wins: the row isn't wanted either way.
      if (decision.kind === "drop") return DROP;
      if (decision.kind === "uncheckable") uncheckable ??= decision;
    }
    return uncheckable ?? KEEP;
  };
}
