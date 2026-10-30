import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { parseCsv } from "./read-csv.js";

const HEADER = "id;asset_name;ip;created_utc;source;category";

describe("parseCsv", () => {
  it("reads rows by column name, with their line numbers", () => {
    const { rows, unreadable } = parseCsv(`${HEADER}\n1;a;1.2.3.4;27/02/2024 00:00;defender;phising\n`);

    expect(unreadable).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        id: "1",
        asset_name: "a",
        ip: "1.2.3.4",
        created_utc: "27/02/2024 00:00",
        source: "defender",
        category: "phising",
      },
    ]);
  });

  it.each([
    ["CRLF line endings", `${HEADER}\r\n1;a;b;c;d;e\r\n`],
    ["no final newline", `${HEADER}\n1;a;b;c;d;e`],
    ["a byte order mark", `﻿${HEADER}\n1;a;b;c;d;e\n`],
    ["empty lines", `${HEADER}\n\n1;a;b;c;d;e\n\n`],
  ])("handles %s", (_name, text) => {
    expect(parseCsv(text).rows).toHaveLength(1);
  });

  it("finds columns whatever their order, and ignores extra ones", () => {
    const { rows } = parseCsv("category;extra;id;asset_name;ip;created_utc;source\nphishing;x;1;a;b;c;d\n");

    expect(rows[0]).toMatchObject({ id: "1", category: "phishing", source: "d" });
  });

  it("reports a row with the wrong number of fields and keeps the others", () => {
    const { rows, unreadable } = parseCsv(`${HEADER}\n1;a;b;c;d;e\n2;a;b;c;d\n3;a;b;c;d;e\n`);

    expect(rows.map((r) => r.id)).toEqual(["1", "3"]);
    expect(unreadable).toEqual([
      { line: 3, fields: ["2", "a", "b", "c", "d", ""], reason: "expected 6 fields but found 5" },
    ]);
  });

  it.each([
    ["uppercase", "ID;ASSET_NAME;IP;CREATED_UTC;SOURCE;CATEGORY"],
    ["spaces around names", "id ; asset_name ; ip ; created_utc ; source ; category"],
  ])("accepts headers with %s", (_name, header) => {
    expect(parseCsv(`${header}\n1;a;b;c;d;e\n`).rows[0]).toMatchObject({ id: "1", category: "e" });
  });

  it("refuses a required column that appears twice, as either could be the real one", () => {
    expect(() => parseCsv(`id;${HEADER}\n9;1;a;b;c;d;e\n`)).toThrow("more than once: id");
  });

  it("refuses a quote that never closes, naming the problem", () => {
    expect(() => parseCsv(`${HEADER}\n1;"a;b;c;d;e\n2;a;b;c;d;e\n`)).toThrow("never closed");
  });

  it("gives a multi-line row the line it starts on, and later rows their real line", () => {
    const { rows } = parseCsv(`${HEADER}\n1;a;b;c;d;e\n2;"x\ny";b;c;d;e\n3;a;b;c;d;e\n`);

    expect(rows.map((r) => r.line)).toEqual([2, 3, 5]);
  });

  it("does not fail the file because of a stray quote", () => {
    const { rows } = parseCsv(`${HEADER}\n1;a"b;c;d;e;f\n`);

    expect(rows[0]?.asset_name).toBe('a"b');
  });

  it.each([
    ["an empty file", "", "id, asset_name"],
    ["a missing column", "id;asset_name;ip;created_utc;source\n1;a;b;c;d\n", "category"],
    ["a comma-delimited file", "id,asset_name,ip,created_utc,source,category\n", "category"],
  ])("refuses %s", (_name, text, message) => {
    expect(() => parseCsv(text)).toThrow(UsageError);
    expect(() => parseCsv(text)).toThrow(message);
  });

  it("reads the sample file, finding the one short row", () => {
    const text = readFileSync(new URL("../../../example_data_2.csv", import.meta.url), "utf8");

    const { rows, unreadable } = parseCsv(text);

    expect(rows).toHaveLength(998);
    expect(unreadable.map((r) => r.line)).toEqual([105]);
    expect(rows.find((r) => r.line === 436)?.ip).toBe("N");
  });
});
