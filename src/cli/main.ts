import { Command, InvalidArgumentError } from "commander";
import { UsageError } from "./errors.js";
import { EXIT_USAGE, runIngest } from "./run.js";

// The server sends a heartbeat every 5 s, so this allows for several missed ones.
const IDLE_TIMEOUT_MS = 30_000;

const collect = (value: string, previous: string[]) => [...previous, value];

function parseApiUrl(value: string): string {
  if (!URL.canParse(value)) throw new InvalidArgumentError("must be a URL, like http://localhost:3000");
  return value;
}

const program = new Command()
  .name("ingest-cli")
  .description("Upload malicious activity logs to the analytics platform")
  // Commander exits 1 on bad usage by default, which would look like a failed run to a script.
  .exitOverride((err) => process.exit(err.exitCode === 0 ? 0 : EXIT_USAGE));

program
  .command("ingest")
  .description("Send the rows of a semicolon-delimited CSV file to the API")
  .argument("<file>", "CSV file to ingest")
  .option("--api-url <url>", "URL of the ingest API", parseApiUrl, "http://localhost:3000")
  .option("--source <name>", "only rows from this source (repeatable)", collect, [])
  .option("--asset <name>", "only rows for this asset (repeatable)", collect, [])
  .option("--category <name>", "only rows in this category, in any spelling")
  .option("--from <date>", "only rows on or after this date (DD/MM/YYYY or YYYY-MM-DD, UTC)")
  .option("--to <date>", "only rows on or before this date (DD/MM/YYYY or YYYY-MM-DD, UTC)")
  .option("--rejects <path>", "where to write rows that need attention (default: <file>.rejects.csv)")
  .action(async (file: string, flags) => {
    const interrupt = new AbortController();
    process.once("SIGINT", () => interrupt.abort());

    process.exitCode = await runIngest(
      {
        file,
        apiUrl: flags.apiUrl,
        rejectsPath: flags.rejects ?? `${file}.rejects.csv`,
        filter: { source: flags.source, asset: flags.asset, category: flags.category, from: flags.from, to: flags.to },
      },
      {
        fetch: globalThis.fetch,
        signal: interrupt.signal,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        print: (message) => console.log(message),
      },
    );
  });

program.parseAsync().catch((err: unknown) => {
  if (!(err instanceof UsageError)) throw err;
  console.error(err.message);
  process.exitCode = EXIT_USAGE;
});
