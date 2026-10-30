import { describe, expect, it } from "vitest";
import { parseCsv } from "./read-csv.js";
import { formatRejects } from "./write-rejects.js";

const fields = ["1", "server_a", "N", "27/02/2024 00:00", "defender", "phising"];

describe("formatRejects", () => {
  it("writes the original columns plus line and reason", () => {
    expect(formatRejects([{ line: 436, fields, reason: "invalid ip" }])).toBe(
      "id;asset_name;ip;created_utc;source;category;line;reason\r\n" +
        "1;server_a;N;27/02/2024 00:00;defender;phising;436;invalid ip\r\n",
    );
  });

  it.each([
    ["=HYPERLINK(1)", "'=HYPERLINK(1)"],
    ["+1", "'+1"],
    ["-1", "'-1"],
    ["@cmd", "'@cmd"],
    ["\tcmd", "'\tcmd"],
    ["safe=value", "safe=value"],
  ])("neutralises the formula risk in %j", (cell, expected) => {
    const output = formatRejects([{ line: 2, fields: [cell, "", "", "", "", ""], reason: "r" }]);

    expect(output.split("\r\n")[1]?.split(";")[0]).toBe(expected);
  });

  it("quotes cells that would break the columns", () => {
    const output = formatRejects([{ line: 2, fields: ['a;b"c', "", "", "", "", ""], reason: "r" }]);

    expect(output.split("\r\n")[1]).toBe('"a;b""c";;;;;;2;r');
  });

  it("can be read back as input, so failed rows can be fixed and rerun", () => {
    const output = formatRejects([{ line: 436, fields, reason: "invalid ip" }]);

    const { rows, unreadable } = parseCsv(output);

    expect(unreadable).toEqual([]);
    expect(rows[0]).toMatchObject({ id: "1", ip: "N", category: "phising", line: 2 });
  });
});
