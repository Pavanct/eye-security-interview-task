import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./errors.js";
import { EXIT_INCOMPLETE, EXIT_OK, runIngest } from "./run.js";

const HEADER = "id;asset_name;ip;created_utc;source;category";
const row = (id: number, source = "defender", category = "phishing") =>
  `${id};server_a;1.2.3.4;27/02/2024 00:00;${source};${category}`;

const summary = (overrides: object = {}) => ({
  type: "summary",
  summary: {
    received: 2,
    rejected: 0,
    idConflicts: 0,
    enrichmentFailed: 0,
    sent: 2,
    ingested: 2,
    analyticsFailed: 0,
    possibleDuplicates: 0,
    ...overrides,
  },
});
const ndjson = (...events: unknown[]) => new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ingest-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(lines: string[], fetchFn: typeof fetch, filter = {}) {
  const file = join(dir, "input.csv");
  const rejectsPath = join(dir, "input.rejects.csv");
  await writeFile(file, `${[HEADER, ...lines].join("\r\n")}\r\n`);
  const output: string[] = [];

  const exitCode = await runIngest(
    { file, apiUrl: "http://api.test", rejectsPath, filter: { source: [], asset: [], category: [], ...filter } },
    {
      fetch: fetchFn,
      signal: new AbortController().signal,
      idleTimeoutMs: 1000,
      print: (message) => output.push(message),
    },
  );
  return {
    exitCode,
    output: output.join("\n"),
    rejects: existsSync(rejectsPath) ? await readFile(rejectsPath, "utf8") : undefined,
  };
}

const sentRecords = (fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) =>
  JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).records as Array<Record<string, unknown>>;

describe("given every row is stored", () => {
  it("when the run finishes, then it exits 0 and writes no rejects file", async () => {
    const { exitCode, output, rejects } = await run([row(1), row(2)], async () =>
      ndjson({ type: "batch_sent", lines: [2, 3], ingested: 2 }, summary()),
    );

    expect(exitCode).toBe(EXIT_OK);
    expect(rejects).toBeUndefined();
    expect(output).toContain("Stored 2 of 2 rows");
  });

  it("when sending, then only the fields the API needs are included", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ndjson(summary()));

    await run([row(1), row(2)], fetchFn);

    expect(sentRecords(fetchFn)[0]).toEqual({
      line: 2,
      id: "1",
      asset: "server_a",
      ip: "1.2.3.4",
      category: "phishing",
    });
  });
});

describe("given a filter", () => {
  it("when rows don't match, then they aren't sent and it's still a success", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ndjson(summary({ received: 1, sent: 1, ingested: 1 })));

    const { exitCode, output } = await run([row(1), row(2, "crowdstrike")], fetchFn, { source: ["defender"] });

    expect(sentRecords(fetchFn).map((r) => r.id)).toEqual(["1"]);
    expect(exitCode).toBe(EXIT_OK);
    expect(output).toMatch(/Filtered out:\s+1/);
  });

  it("when nothing matches, then the API isn't called", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    const { exitCode, output } = await run([row(1)], fetchFn, { source: ["crowdstrike"] });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(exitCode).toBe(EXIT_OK);
    expect(output).toContain("No rows to send.");
  });

  it("when a row's category can't be checked, then it goes to the rejects file", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ndjson(summary({ received: 1, sent: 1, ingested: 1 })));

    const { exitCode, rejects } = await run([row(1), row(2, "defender", "")], fetchFn, { category: ["phishing"] });

    expect(sentRecords(fetchFn).map((r) => r.id)).toEqual(["1"]);
    expect(rejects).toContain("empty category");
    expect(exitCode).toBe(EXIT_INCOMPLETE);
  });
});

describe("given rows with problems", () => {
  it("when a row is too short, then it is reported and never sent", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ndjson(summary({ received: 1, sent: 1, ingested: 1 })));

    const { exitCode, rejects } = await run([row(1), "2;a;b;c;d"], fetchFn);

    expect(sentRecords(fetchFn)).toHaveLength(1);
    expect(rejects).toContain("expected 6 fields but found 5");
    expect(exitCode).toBe(EXIT_INCOMPLETE);
  });

  it("when the API rejects or fails rows, then each is in the rejects file with its reason", async () => {
    const { exitCode, rejects, output } = await run([row(1), row(2), row(3)], async () =>
      ndjson(
        { type: "rejected", line: 2, reason: "invalid ip" },
        { type: "enrichment_failed", line: 3, reason: "enrichment unavailable" },
        { type: "batch_failed", lines: [4], reason: "analytics unavailable" },
        summary({ received: 3, rejected: 1, enrichmentFailed: 1, analyticsFailed: 1, sent: 0, ingested: 0 }),
      ),
    );

    expect(exitCode).toBe(EXIT_INCOMPLETE);
    expect(rejects).toContain("2;invalid ip");
    expect(rejects).toContain("3;enrichment unavailable");
    expect(rejects).toContain("4;analytics unavailable");
    expect(output).toMatch(/Rejected by the API:\s+1/);
  });

  it("when a repeated id is flagged, then it's only a warning", async () => {
    const { exitCode, output } = await run([row(1), row(1)], async () =>
      ndjson(
        { type: "id_conflict", line: 3 },
        { type: "batch_sent", lines: [2, 3], ingested: 2 },
        summary({ idConflicts: 1 }),
      ),
    );

    expect(exitCode).toBe(EXIT_OK);
    expect(output).toContain("Line 3: repeated id, sent anyway");
  });

  it("when a batch is only partly stored, then all its rows are flagged, as we can't tell which", async () => {
    const { exitCode, rejects, output } = await run([row(1), row(2)], async () =>
      ndjson({ type: "batch_sent", lines: [2, 3], ingested: 1 }, summary({ ingested: 1 })),
    );

    expect(exitCode).toBe(EXIT_INCOMPLETE);
    expect(output).toContain("only 1 of 2 in this batch were stored");
    expect(rejects?.match(/only 1 of 2/g)).toHaveLength(2);
  });
});

describe("given a rejects file from an earlier run", () => {
  it("when the next run has rejects too, then they are added and the earlier ones are kept", async () => {
    const fetchFn = async () => ndjson(summary({ received: 1, sent: 1, ingested: 1 }));

    await run([row(1), "2;a;b;c;d"], fetchFn);
    const { rejects } = await run([row(1), "3;a;b;c;d"], fetchFn);

    const lines = rejects?.trim().split("\r\n") ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^id;asset_name/);
    expect(lines[1]).toMatch(/^2;a;/);
    expect(lines[2]).toMatch(/^3;a;/);
  });
});

describe("given a batch may have been stored twice", () => {
  it("when the run finishes, then its rows are flagged and it doesn't exit 0", async () => {
    const { exitCode, rejects, output } = await run([row(1), row(2)], async () =>
      ndjson(
        { type: "batch_sent", lines: [2, 3], ingested: 2, possibleDuplicates: true },
        summary({ possibleDuplicates: 2 }),
      ),
    );

    expect(exitCode).toBe(EXIT_INCOMPLETE);
    expect(output).toMatch(/Possible duplicates:\s+2/);
    expect(rejects?.match(/stored, but possibly twice/g)).toHaveLength(2);
  });
});

describe("given the run doesn't finish", () => {
  it.each([
    ["the stream ends early", async () => ndjson({ type: "batch_sent", lines: [2], ingested: 1 }), "incomplete"],
    [
      "the API stops the run",
      async () =>
        ndjson(
          { type: "batch_sent", lines: [2], ingested: 1 },
          { type: "run_failed", reason: "server is shutting down" },
        ),
      "server is shutting down",
    ],
  ] as Array<[string, typeof fetch, string]>)(
    "when %s, then unconfirmed rows are reported",
    async (_name, fetchFn, message) => {
      const { exitCode, output, rejects } = await run([row(1), row(2)], fetchFn);

      expect(exitCode).toBe(EXIT_INCOMPLETE);
      expect(output).toContain(message);
      expect(rejects).toContain("3;run did not finish");
      expect(rejects).not.toContain("2;run did not finish");
    },
  );

  it("when the API can't be reached, then every row is reported", async () => {
    const { exitCode, output, rejects } = await run([row(1)], async () => {
      throw new TypeError("fetch failed");
    });

    expect(exitCode).toBe(EXIT_INCOMPLETE);
    expect(output).toContain("Could not reach the API");
    expect(rejects).toContain("2;not sent: the API did not take the request");
    expect(rejects).not.toContain("may already be stored");
  });

  it("when the API refuses the request, then its message is shown and the rows are safe to resend", async () => {
    const { exitCode, output, rejects } = await run(
      [row(1)],
      async () => new Response(JSON.stringify({ error: "too many records" }), { status: 413 }),
    );

    expect(exitCode).toBe(EXIT_INCOMPLETE);
    expect(output).toContain("too many records");
    expect(rejects).toContain("2;not sent: the API did not take the request");
    expect(rejects).not.toContain("may already be stored");
  });
});

describe("given a problem with the rejects path", () => {
  const options = (rejectsPath: string) => ({
    file: join(dir, "input.csv"),
    apiUrl: "http://api.test",
    rejectsPath,
    filter: { source: [], asset: [], category: [] },
  });

  async function runWith(rejectsPath: string, fetchFn: typeof fetch) {
    const input = `${[HEADER, row(1), "2;a;b;c;d"].join("\r\n")}\r\n`;
    await writeFile(join(dir, "input.csv"), input);
    const output: string[] = [];
    const exitCode = await runIngest(options(rejectsPath), {
      fetch: fetchFn,
      signal: new AbortController().signal,
      idleTimeoutMs: 1000,
      print: (message) => output.push(message),
    });
    return { exitCode, output: output.join("\n"), input };
  }

  it("when it is the input file, then nothing is sent and the input is untouched", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const before = `${[HEADER, row(1)].join("\r\n")}\r\n`;
    await writeFile(join(dir, "input.csv"), before);

    // A different spelling of the same path must not get past the check.
    const samePath = join(dir, ".", "sub", "..", "input.csv");
    const deps = { fetch: fetchFn, signal: new AbortController().signal, idleTimeoutMs: 1000, print: () => {} };

    await expect(runIngest(options(samePath), deps)).rejects.toThrow("must not be the input file");

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "input.csv"), "utf8")).toBe(before);
  });

  it("when its folder doesn't exist, then nothing is sent", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    await expect(runWith(join(dir, "missing", "r.csv"), fetchFn)).rejects.toThrow("Can't write the rejects file");

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("when writing fails after the run, then the rows are still listed", async () => {
    // The path passes the check at the start, but a folder can't be written as a file.
    const { exitCode, output } = await runWith(dir, async () =>
      ndjson({ type: "batch_sent", lines: [2], ingested: 1 }, summary({ received: 1, sent: 1, ingested: 1 })),
    );

    expect(exitCode).toBe(EXIT_INCOMPLETE);
    expect(output).toContain("Could not write");
    expect(output).toContain("Line 3: expected 6 fields but found 5");
  });
});

describe("given bad input", () => {
  it("when the file doesn't exist, then it's a usage error", async () => {
    const options = {
      file: join(dir, "missing.csv"),
      apiUrl: "http://api.test",
      rejectsPath: join(dir, "r.csv"),
      filter: { source: [], asset: [], category: [] },
    };
    const deps = { fetch, signal: new AbortController().signal, idleTimeoutMs: 1000, print: () => {} };

    await expect(runIngest(options, deps)).rejects.toThrow(UsageError);
  });

  it("when a flag is invalid, then nothing is sent", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    await expect(run([row(1)], fetchFn, { from: "yesterday" })).rejects.toThrow(UsageError);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
