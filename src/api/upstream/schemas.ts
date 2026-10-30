import { z } from "zod";
import { CATEGORIES } from "../../shared/category/categories.js";

// Hand-written from openapi.json rather than generated. The spec has no `required`
// lists, so generated types would mark every field optional and give no runtime
// checks. These schemas tighten it: fields the pipeline depends on are required.
// schemas.contract.test.ts keeps them in line with the spec.

export const MITRE_TECHNIQUES = [
  "T1659",
  "T1189",
  "T1190",
  "T1133",
  "T1200",
  "T1566",
  "T1091",
  "T1195",
  "T1199",
  "T1078",
] as const;

// ASSUMPTION: asset names are hostname-like. This allowlist also keeps control
// characters and formula prefixes out of logs and of the analytics store.
const assetSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/);
const ipSchema = z.union([z.ipv4(), z.ipv6()]);

export const logLineSchema = z.object({
  id: z.int().nonnegative(),
  asset: assetSchema,
  ip: ipSchema,
  category: z.enum(CATEGORIES),
});
export type LogLine = z.infer<typeof logLineSchema>;

// The Enrichment Service is known to be unreliable, so a 200 is not trusted either.
export const enrichmentResponseSchema = z.object({
  asn: z.string().min(1),
  category: z.enum(MITRE_TECHNIQUES),
  correlationId: z.int(),
});
export type EnrichmentDetails = z.infer<typeof enrichmentResponseSchema>;

export const analyticsEventSchema = z.object({
  id: z.int().nonnegative(),
  asset: assetSchema,
  ip: ipSchema,
  category: z.enum(MITRE_TECHNIQUES),
  asn: z.string().min(1),
  correlationId: z.int(),
});
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

// A 200 can still carry status "error" or a partial itemsIngested.
export const analyticsResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  itemsIngested: z.int().nonnegative(),
});
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;
