# Malicious activity log ingestion

A CLI and a small API that take a CSV of malicious activity logs, enrich each record, and load it into the Analytics Service used for incident response.

```
                 CSV
                  │
            ┌─────▼─────┐   POST /ingest      ┌───────────┐   per record   ┌────────────┐
            │    CLI    │ ──────────────────► │    API    │ ─────────────► │ Enrichment │
            │ parse     │   NDJSON stream of  │ validate  │                └────────────┘
            │ filter    │ ◄────────────────── │ enrich    │
            │ report    │   progress events   │ batch     │   1 batch      ┌────────────┐
            └─────┬─────┘                     │ rate limit│ ─────────────► │ Analytics  │
                  │                           └───────────┘   per 10 s     └────────────┘
          rejects file with
          a reason per row
```

The main idea: **every row ends up accounted for**. It's stored, filtered out, or listed in a rejects file with a reason. The CLI only reports success if it can prove it.

Full reasoning is in the [decision log](docs/decisions.md).

## Running it

You need Node 26 (24 also works, 25 doesn't) and pnpm.

```bash
nvm use
pnpm install --frozen-lockfile
cp .env.example .env        # set UPSTREAM_API_KEY to the key from the assignment

pnpm api                                  # terminal 1
pnpm -s cli ingest example_data_2.csv     # terminal 2
```

The full sample takes about 9 minutes because of the rate limit. For a quick look, this sends 7 rows:

```bash
pnpm -s cli ingest example_data_2.csv --source defender --category phishing --from 01/03/2024 --to 2024-03-31
```

Both write to the real Analytics Service. Filters are `--source`, `--asset`, `--category`, `--from` and `--to`. Different flags combine with AND, and a repeated flag means OR. See `--help` for the rest.

Exit code 0 means everything that should be stored was. 1 means some rows need attention or the run didn't finish, and 2 means bad usage. The sample always exits 1, because it has bad rows on purpose.

## What changed along the way

A few things I planned didn't survive building it or testing the real service:

- **Enrichment attempts went from 3 to 5.** In a small test, 7 of 30 calls returned a 500. At that rate, 3 attempts would lose about 1% of records.
- **The 429 handling changed.** The real 429 comes with `Retry-After: 10` and an HTML body, neither of which is in the spec. Parsing it as JSON would have broken the first time it was hit. A bad key also returns an undocumented 401.
- **I removed my concurrency helper.** I first limited enrichment to 5 calls at a time, then compared the numbers: about 30 ms per call, against one analytics batch every 10.5 s. Enrichment speed doesn't change how long a run takes, so a plain loop over groups of 20 is enough.
- **Duplicates are flagged instead of skipped.** I planned to skip identical rows, but the API never receives `created_utc` or `source`, so two different events could look the same to it. Skipping one would lose evidence.
- **I dropped generated types.** The spec has no `required` lists, so they'd accept an event with no `asn`, and the generator doesn't work with TypeScript 7. The schemas are hand-written, with a contract test against the spec.
- **A bad API key now stops the run.** At first every record failed with its own 401, which was correct but useless.
- **Possible duplicates are now reported.** A code review pointed out that a retry after a timeout could store a batch twice while the run still exited 0. I still retry, because a lost event is worse, but those rows are flagged and the exit code is 1.
- **Retries now log why they happened.** In the first real run, 2 of 50 batches took a second attempt, and the logs couldn't tell me whether it was a harmless 429 or a timeout that might have stored them twice. With the reason logged, the next run showed 429s, exactly 210 s apart, which is every 20 batches at my 10.5 s interval. They cost about 10 s each and lose nothing. I suspect the service uses fixed time slots that my interval drifts across, but I haven't proved it.

## How it works

The CLI parses and filters the file, then POSTs the rows. The API validates each record itself, because it can't trust a client, and splits the valid ones into groups of 20. It enriches a group with retries, sends it to analytics when the rate limiter allows, and moves on.

Events stream back throughout. The stream ends with `summary` if the run finished, or `run_failed` if the API had to stop. If it ends with neither, the connection died, and the CLI reports an incomplete run.

## Design decisions

- **One endpoint that streams NDJSON.** A run takes minutes and the user needs feedback. The usual answer is an async job with polling, but that needs a second endpoint and durable storage. The cost is that nothing can reattach if the CLI dies.
- **1 request per 10 s, up to 20 items.** The brief says 20 messages per 10 s, and the spec says 1 request per 10 s. This satisfies both, and the real service confirmed it. It's in memory, so it only works with one instance.
- **Validation in the API, with an explicit alias table.** I decided against fuzzy matching, because a wrong guess could mislabel an attack technique. Unknown values are rejected.
- **Retry, then report.** One bad record or a brief outage shouldn't fail the file, and a flagged duplicate is better than a lost event.
- **TypeScript, Hono, one package.** The work is waiting on the network, streaming is central, and one endpoint doesn't justify a large framework.

## The sample data

It's dirty on purpose: about 20 spellings of 10 categories, a missing column on line 105, `N` as an IP on line 436, an empty category on line 675, and 3 repeated ids. Spellings are fixed by cleanup and the alias table. The bad rows are reported with reasons in the rejects file, which can be fixed and used as input. Runs append to that file, so a rerun can't wipe out what an earlier run reported, though a row rejected twice is listed twice. The repeated ids are sent and flagged, because they're different events.

## Performance

Analytics is the bottleneck, so batching is the main technique, and the rate limit requires it. Enriching one group at a time means nothing piles up in memory, and request size is limited. A full run of the sample against the real service took about 8.9 minutes and stored all 996 valid records.

## Error handling

Each failure is handled per record or per batch, so the rest of the file carries on. The less obvious cases:

| Failure | What happens |
|---|---|
| Enrichment keeps failing | After 5 attempts the record is reported, and never sent unenriched |
| Analytics 429 | Waits for `Retry-After`, then retries through the rate limiter |
| Analytics timeout, 5xx or network error | Up to 3 attempts. A later success is flagged as a possible duplicate |
| Partial `itemsIngested` | No retry, as it would duplicate items. The whole batch is flagged, because the response doesn't say which were stored |
| API dies or goes silent | The CLI reports an incomplete run and lists unconfirmed rows |
| SIGTERM | Each run finishes its current batch and tells the client why it stopped. After 30 s it exits regardless |

The full list is in [ADR-4](docs/decisions.md#adr-4-retry-transient-failures-and-isolate-failures-per-record).

## Testing

Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Unit tests sit next to the code. Integration tests run the real CLI and API over HTTP, with only the two external services faked, copying what the real service was seen to do. I also ran the full sample against the real service and followed this README from a fresh clone.

As a last check, I generated about 50 awkward CSVs and sent bad requests straight to the API, all against a fake upstream: formula and SQL injection, escape codes, log-forging newlines, binary and UTF-16 files, oversized fields, and files right at the size limit. The API held up, and the accounting was right in every run. The CLI wasn't as solid, and this is what I fixed:

- **`--rejects` pointing at the input file overwrote the input.** It's now refused. For forensic data, that was the worst one.
- **An unwritable rejects path crashed after the rows were stored,** losing the list of rows needing attention. The path is now checked before anything is sent, and if writing still fails, the rows are printed.
- **A refused request said rows "may already be stored",** when nothing had been sent. It now says they're safe to resend.
- **`--category a --category b` silently used only the last one,** while `--source` allowed several. Now they all work the same way.
- **Smaller fixes:** `007` and `7` were treated as the same id, so leading zeros are now rejected. Escape codes no longer reach the rejects file as raw bytes. Multi-line rows report the line they start on, headers ignore case and spaces, a repeated column is refused, and `--api-url` refuses a path it would have ignored. The API now requires a JSON content type.

These were one-off checks, and a few representative cases are now in the test suite.

I used AI assistance for much of the code and for the code review. I made the decisions, reviewed the code, and tested it against the real service.

## Observability

It's structured JSON logs through pino, with a run id. There are no metrics or tracing. For production I'd add metrics for records by outcome and retries by reason, since retries show Enrichment getting worse before records start failing, and alert on those.

## Security

I treated the input as hostile, since these are logs of malicious activity, and followed basic practices from [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet): allowlist validation, no raw input in logs or errors, and formula protection in the rejects file. The API key comes from the environment and is never logged.

Our own API's auth is out of scope, but as it stands anyone who can reach `/ingest` can write to analytics. Production would need SSO limited to a SecOps role, an audit trail of who uploaded what, and a separate least-privilege identity for the API, with its own credentials per service.

## Assumptions

- Every field in the enrichment response is required, though the spec leaves them optional.
- Asset names look like hostnames, so a name with a space is rejected.
- `exploit public facing` means `exploitpublicfacingapplication`. Each alias is my guess at what SecOps meant, so I'd want them to check the table.
- `created_utc` is UTC and day-first.
- A repeated id is a separate event, not a duplicate to drop.
- Ids have no leading zeros, and fullwidth letters in a category count as the normal letters.

## Known gaps and what I'd do next

- **No resume, and deploys interrupt long runs.** A durable queue and job store is what I'd build first. It would also allow more than one instance, which the in-memory rate limiter prevents today.
- **Duplicates are flagged, not prevented.** The real fix is an idempotency key from the Analytics team, which nothing on our side can replace.
- **No circuit breaker.** During a long enrichment outage, every record still uses all its attempts.
- **Overlapping runs add up.** Each can make 20 enrichment calls at once, and they share the analytics budget.
- **Files over 5,000 rows are refused,** not split.
- **A quote that never closes refuses the whole file.** Nothing gets swallowed silently, but one bad row blocks the rest until it's fixed.
- **`main.ts` has no automated test.** I checked its signal handling by hand.
- **No CI.** Lint, type check and tests only run locally. A small GitHub Actions workflow is the obvious next step.
- **No `/health` endpoint,** because the brief asks for one endpoint, though production would want one.
