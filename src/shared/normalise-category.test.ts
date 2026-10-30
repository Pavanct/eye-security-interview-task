import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "./categories.js";
import { normaliseCategory } from "./normalise-category.js";

describe("normaliseCategory", () => {
  it.each([
    ["phishing", "phishing", "exact"],
    ["Replication through removable media", "replicationthroughremovablemedia", "exact"],
    ["replication-through-removable-media", "replicationthroughremovablemedia", "exact"],
    ["trusted relationship", "trustedrelationship", "exact"],
    ["trusted-relationship", "trustedrelationship", "exact"],
    ["content injection", "contentinjection", "exact"],
    ["content_injection", "contentinjection", "exact"],
    ["supply chain compromise", "supplychaincompromise", "exact"],
    ["supply_chain_compromise", "supplychaincompromise", "exact"],
    ["drive by compromise", "drivebycompromise", "exact"],
    ["drive-by-compromise", "drivebycompromise", "exact"],
    ["valid accounts", "validaccounts", "exact"],
    ["valid-accounts", "validaccounts", "exact"],
    ["  PHISHING  ", "phishing", "exact"],
    ["phising", "phishing", "alias"],
    ["Phising", "phishing", "alias"],
    ["valida_accounts", "validaccounts", "alias"],
    ["exploit public facing", "exploitpublicfacingapplication", "alias"],
    ["explaoit-public facing", "exploitpublicfacingapplication", "alias"],
    ["compromise (driveby)", "drivebycompromise", "alias"],
    ["external remote service", "externalremoteservices", "alias"],
    ["external-remote-service", "externalremoteservices", "alias"],
  ])("maps %j to %s (%s)", (raw, category, matchedBy) => {
    expect(normaliseCategory(raw)).toEqual({ ok: true, category, matchedBy });
  });

  it.each(CATEGORIES)("accepts the canonical value %s unchanged", (category) => {
    expect(normaliseCategory(category)).toEqual({ ok: true, category, matchedBy: "exact" });
  });

  it.each(["", "   ", "\t", "-_ ()"])("rejects %j as empty", (raw) => {
    expect(normaliseCategory(raw)).toEqual({ ok: false, reason: "empty category" });
  });

  it.each(["phishng", "phishing!", "=cmd()", "constructor", "__proto__", "phishing\nvalidaccounts!"])(
    "fails closed on %j",
    (raw) => {
      expect(normaliseCategory(raw)).toEqual({ ok: false, reason: "unknown category" });
    },
  );

  it("handles every category in the sample file, apart from the one empty value", () => {
    const rows = readFileSync(new URL("../../example_data_2.csv", import.meta.url), "utf8")
      .split("\r\n")
      .slice(1)
      .map((line) => line.split(";"))
      .filter((fields) => fields.length === 6);

    const failures = rows.map((fields) => fields[5] ?? "").filter((raw) => !normaliseCategory(raw).ok);

    expect(rows).toHaveLength(998);
    expect(failures).toEqual([""]);
  });
});
