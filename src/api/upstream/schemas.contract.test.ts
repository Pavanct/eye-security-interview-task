import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../../shared/category/categories.js";
import {
  MITRE_TECHNIQUES,
  analyticsEventSchema,
  analyticsResponseSchema,
  enrichmentResponseSchema,
  logLineSchema,
} from "./schemas.js";

const spec = JSON.parse(readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"));
const schemas = spec.components.schemas;

// Builds a payload from the spec's own first examples, so a change in the spec's
// shape or field names fails here instead of at runtime against the real service.
function fromExamples(schema: { properties: Record<string, { examples?: unknown[]; enum?: unknown[] }> }) {
  return Object.fromEntries(
    Object.entries(schema.properties).map(([name, prop]) => [name, prop.examples?.[0] ?? prop.enum?.[0]]),
  );
}

describe("schemas match openapi.json", () => {
  it("allows the same enrichment categories", () => {
    expect([...CATEGORIES].sort()).toEqual([...schemas.Logline.properties.category.enum].sort());
  });

  it("allows the same analytics techniques", () => {
    expect([...MITRE_TECHNIQUES].sort()).toEqual([...schemas.AnalyticsEvent.properties.category.enum].sort());
  });

  it("has the same field names as the spec", () => {
    expect(Object.keys(logLineSchema.shape).sort()).toEqual(Object.keys(schemas.Logline.properties).sort());
    expect(Object.keys(enrichmentResponseSchema.shape).sort()).toEqual(
      Object.keys(schemas.EnrichmentDetailsResponse.properties).sort(),
    );
    expect(Object.keys(analyticsEventSchema.shape).sort()).toEqual(
      Object.keys(schemas.AnalyticsEvent.properties).sort(),
    );
    expect(Object.keys(analyticsResponseSchema.shape).sort()).toEqual(
      Object.keys(schemas.AnalyticsSuccessResponse.properties).sort(),
    );
  });

  it("accepts the spec's own examples", () => {
    expect(logLineSchema.safeParse(fromExamples(schemas.Logline)).success).toBe(true);
    expect(enrichmentResponseSchema.safeParse(fromExamples(schemas.EnrichmentDetailsResponse)).success).toBe(true);
    expect(analyticsEventSchema.safeParse(fromExamples(schemas.AnalyticsEvent)).success).toBe(true);
    expect(analyticsResponseSchema.safeParse(fromExamples(schemas.AnalyticsSuccessResponse)).success).toBe(true);
  });
});

describe("upstream responses", () => {
  const enrichment = { asn: "ASN1337", category: "T1566", correlationId: 23578 };

  it("requires the fields the pipeline depends on, though the spec leaves them optional", () => {
    expect(enrichmentResponseSchema.safeParse(enrichment).success).toBe(true);
    for (const field of Object.keys(enrichment)) {
      const { [field as keyof typeof enrichment]: _dropped, ...partial } = enrichment;
      expect(enrichmentResponseSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("rejects an enrichment technique outside the analytics enum", () => {
    expect(enrichmentResponseSchema.safeParse({ ...enrichment, category: "T9999" }).success).toBe(false);
  });

  it("accepts a 200 that reports an error or partial ingestion", () => {
    expect(analyticsResponseSchema.parse({ status: "error", itemsIngested: 3 })).toEqual({
      status: "error",
      itemsIngested: 3,
    });
  });
});
