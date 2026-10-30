import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRecord } from "./validate-record.js";

const record = { line: 7, id: "119611", asset: "server_horizon", ip: "102.145.229.227", category: "phishing" };

describe("validateRecord", () => {
  it("returns a typed log line with a normalised category", () => {
    expect(validateRecord({ ...record, category: "Phising" })).toEqual({
      ok: true,
      line: 7,
      logLine: { id: 119611, asset: "server_horizon", ip: "102.145.229.227", category: "phishing" },
      categoryMatchedBy: "alias",
    });
  });

  it("accepts an IPv6 address", () => {
    expect(validateRecord({ ...record, ip: "2001:db8::1" }).ok).toBe(true);
  });

  it.each([
    ["invalid id", { id: "abc" }],
    ["invalid id", { id: "" }],
    ["invalid id", { id: "-1" }],
    ["invalid id", { id: "1.5" }],
    ["invalid id", { id: "99999999999999999" }],
    ["invalid id", { id: "9999999999999999" }],
    ["invalid ip", { ip: "N" }],
    ["invalid ip", { ip: "" }],
    ["invalid ip", { ip: "999.1.1.1" }],
    ["invalid asset", { asset: "" }],
    ["invalid asset", { asset: "=HYPERLINK(1)" }],
    ["invalid asset", { asset: "server\nfake log line" }],
    ["invalid asset", { asset: "a".repeat(256) }],
    ["empty category", { category: "" }],
    ["unknown category", { category: "=cmd()" }],
  ])("rejects with %j for %j", (reason, override) => {
    expect(validateRecord({ ...record, ...override })).toEqual({ ok: false, line: 7, reason });
  });

  it("never echoes the raw value in a reason", () => {
    const secret = "<<attacker-controlled>>";
    for (const field of ["id", "asset", "ip", "category"]) {
      const result = validateRecord({ ...record, [field]: secret });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("rejects exactly the known bad rows in the sample file", () => {
    const lines = readFileSync(new URL("../../example_data_2.csv", import.meta.url), "utf8").split("\r\n");
    const rejected: Array<[number, string]> = [];

    lines.forEach((text, index) => {
      const fields = text.split(";");
      if (index === 0 || fields.length !== 6) return;
      const [id = "", asset = "", ip = "", , , category = ""] = fields;
      const result = validateRecord({ line: index + 1, id, asset, ip, category });
      if (!result.ok) rejected.push([result.line, result.reason]);
    });

    expect(rejected).toEqual([
      [436, "invalid ip"],
      [675, "empty category"],
    ]);
  });
});
