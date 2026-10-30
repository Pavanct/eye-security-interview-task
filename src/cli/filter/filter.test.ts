import { describe, expect, it } from "vitest";
import type { CsvRow } from "../csv/read-csv.js";
import { UsageError } from "../errors.js";
import { buildFilter, type FilterFlags } from "./filter.js";

const row: CsvRow = {
  line: 2,
  id: "1",
  asset_name: "server_a",
  ip: "1.2.3.4",
  created_utc: "27/02/2024 00:00",
  source: "defender",
  category: "phising",
};

const flags = (overrides: Partial<FilterFlags>): FilterFlags => ({ source: [], asset: [], ...overrides });
const decide = (overrides: Partial<FilterFlags>, target: CsvRow = row) => buildFilter(flags(overrides))(target).kind;

describe("buildFilter", () => {
  it("keeps everything with no flags", () => {
    expect(decide({})).toBe("keep");
  });

  it.each([
    ["source matches", { source: ["defender"] }, "keep"],
    ["source matches in another case", { source: ["DEFENDER"] }, "keep"],
    ["source differs", { source: ["crowdstrike"] }, "drop"],
    ["one repeated source matches", { source: ["crowdstrike", "defender"] }, "keep"],
    ["source is only a prefix", { source: ["def"] }, "drop"],
    ["asset matches", { asset: ["server_a"] }, "keep"],
    ["asset differs", { asset: ["server_b"] }, "drop"],
    ["category matches through its alias", { category: "phishing" }, "keep"],
    ["category flag uses the same typo", { category: "Phising" }, "keep"],
    ["category differs", { category: "valid accounts" }, "drop"],
    ["both flags match", { source: ["defender"], asset: ["server_a"] }, "keep"],
    ["only one of two flags matches", { source: ["defender"], asset: ["server_b"] }, "drop"],
  ])("when %s", (_name, overrides, expected) => {
    expect(decide(overrides)).toBe(expected);
  });

  it.each([
    ["on the --from day", { from: "27/02/2024" }, "keep"],
    ["after --from", { from: "26/02/2024" }, "keep"],
    ["before --from", { from: "28/02/2024" }, "drop"],
    ["on the --to day", { to: "27/02/2024" }, "keep"],
    ["after --to", { to: "26/02/2024" }, "drop"],
    ["within a range", { from: "01/02/2024", to: "29/02/2024" }, "keep"],
    ["outside a range", { from: "01/03/2024", to: "31/03/2024" }, "drop"],
    ["with an ISO date", { from: "2024-02-27", to: "2024-02-27" }, "keep"],
  ])("handles a row %s", (_name, overrides, expected) => {
    expect(decide(overrides)).toBe(expected);
  });

  it("reads dates day-first, not month-first", () => {
    const march = { ...row, created_utc: "02/03/2024 00:00" };

    expect(decide({ from: "02/03/2024", to: "02/03/2024" }, march)).toBe("keep");
    expect(decide({ from: "03/02/2024", to: "03/02/2024" }, march)).toBe("drop");
  });

  it("includes the whole --to day", () => {
    expect(decide({ to: "27/02/2024" }, { ...row, created_utc: "27/02/2024 23:59" })).toBe("keep");
  });

  describe("given a row whose value can't be compared", () => {
    it("when filtering by category, then an empty category is uncheckable", () => {
      expect(buildFilter(flags({ category: "phishing" }))({ ...row, category: "" })).toEqual({
        kind: "uncheckable",
        reason: "empty category",
      });
    });

    it("when filtering by date, then a bad date is uncheckable", () => {
      expect(buildFilter(flags({ from: "01/01/2024" }))({ ...row, created_utc: "soon" })).toEqual({
        kind: "uncheckable",
        reason: "invalid created_utc",
      });
    });

    it("when another flag clearly excludes it, then it is simply dropped", () => {
      expect(decide({ category: "phishing", source: ["crowdstrike"] }, { ...row, category: "" })).toBe("drop");
    });

    it("when no flag reads that value, then it is kept for the API to judge", () => {
      expect(decide({ source: ["defender"] }, { ...row, category: "" })).toBe("keep");
    });
  });

  it.each([
    ["an impossible date", { from: "31/02/2024" }, "--from"],
    ["month-first", { to: "02/27/2024" }, "--to"],
    ["not a date", { from: "yesterday" }, "--from"],
    ["from after to", { from: "02/02/2024", to: "01/02/2024" }, "--from must not be later"],
    ["an unknown category", { category: "phishng" }, "--category"],
  ])("refuses %s before reading anything", (_name, overrides, message) => {
    expect(() => buildFilter(flags(overrides))).toThrow(UsageError);
    expect(() => buildFilter(flags(overrides))).toThrow(message);
  });
});
