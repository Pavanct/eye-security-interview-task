import { normaliseCategory } from "../../shared/category/normalise-category.js";
import type { RawRecord } from "../../shared/wire.js";
import { type LogLine, logLineSchema } from "../upstream/schemas.js";

export type ValidatedRecord =
  | { ok: true; line: number; logLine: LogLine; categoryMatchedBy: "exact" | "alias" }
  | { ok: false; line: number; reason: string };

// Numbers beyond MAX_SAFE_INTEGER (16 digits) would silently lose precision in
// JavaScript, so the int64 id from the spec is limited to the safe range here.
const ID_PATTERN = /^\d{1,16}$/;

// The API's trust boundary: raw client input goes in, and either a typed LogLine or
// a fixed reason string comes out. Reasons never contain the input value.
export function validateRecord(record: RawRecord): ValidatedRecord {
  const { line } = record;

  if (!ID_PATTERN.test(record.id)) return { ok: false, line, reason: "invalid id" };

  const normalised = normaliseCategory(record.category);
  if (!normalised.ok) return { ok: false, line, reason: normalised.reason };

  const parsed = logLineSchema.safeParse({
    id: Number(record.id),
    asset: record.asset,
    ip: record.ip,
    category: normalised.category,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { ok: false, line, reason: `invalid ${String(field ?? "record")}` };
  }

  return { ok: true, line, logLine: parsed.data, categoryMatchedBy: normalised.matchedBy };
}
