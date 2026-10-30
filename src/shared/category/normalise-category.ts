import { CATEGORIES, type Category } from "./categories.js";

// Spellings that cleanup alone cannot fix. This is an explicit table, not fuzzy
// matching: a guessed category would silently mislabel an attack technique, which
// is worse for incident response than a rejected record someone can review.
const ALIASES: Readonly<Record<string, Category>> = {
  phising: "phishing",
  validaaccounts: "validaccounts",
  exploitpublicfacing: "exploitpublicfacingapplication",
  explaoitpublicfacing: "exploitpublicfacingapplication",
  compromisedriveby: "drivebycompromise",
  externalremoteservice: "externalremoteservices",
};

const KNOWN: ReadonlySet<string> = new Set(CATEGORIES);

export type NormalisedCategory =
  | { ok: true; category: Category; matchedBy: "exact" | "alias" }
  | { ok: false; reason: "empty category" | "unknown category" };

// Pure and shared: the CLI uses it to filter, the API to validate. The API runs it
// again on its own because it cannot trust what a client sends.
export function normaliseCategory(raw: string): NormalisedCategory {
  // Only known separators are stripped. Removing every non-letter would let
  // `phishing!` or other junk pass as a valid category instead of failing closed.
  const key = raw.normalize("NFKC").trim().toLowerCase().replace(/[\s\-_()]/g, "");

  if (key === "") return { ok: false, reason: "empty category" };
  if (KNOWN.has(key)) return { ok: true, category: key as Category, matchedBy: "exact" };

  // Object.hasOwn so that keys like `constructor` can't resolve through the prototype.
  const alias = Object.hasOwn(ALIASES, key) ? ALIASES[key] : undefined;
  if (alias) return { ok: true, category: alias, matchedBy: "alias" };

  return { ok: false, reason: "unknown category" };
}
