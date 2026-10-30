# Decision log

The main decisions behind the CSV ingestion CLI and API. It's one file because the project is small. If a decision changes while building, its entry says what changed and why.

| # | Decision | Status |
|---|---|---|
| [ADR-1](#adr-1-single-endpoint-that-streams-ndjson) | Single endpoint that streams NDJSON | Accepted |
| [ADR-2](#adr-2-apply-the-stricter-reading-of-the-rate-limit) | Apply the stricter reading of the rate limit | Accepted |
| [ADR-3](#adr-3-validate-in-the-api-reject-bad-rows-and-never-drop-evidence) | Validate in the API, reject bad rows and never drop evidence | Accepted, changed during implementation |
| [ADR-4](#adr-4-retry-transient-failures-and-isolate-failures-per-record) | Retry transient failures and isolate failures per record | Accepted |
| [ADR-5](#adr-5-typescript-hono-and-a-single-package) | TypeScript, Hono and a single package | Accepted |

---

## ADR-1: Single endpoint that streams NDJSON

**Status:** Accepted

### Context

The API "must have a single endpoint", and the CLI must give the user feedback. The Analytics Service limits throughput, so the 999-row sample takes about 8 minutes at best (50 batches, one every 10 seconds). The system is described as mission-critical, so the user has to know exactly what was and wasn't ingested.

### Decision drivers

- Live feedback during a run that lasts minutes.
- The single-endpoint requirement.
- No record may disappear without being accounted for.
- Simple enough to build and explain.

### Considered options

| Option | For | Against |
|---|---|---|
| A. One long synchronous request | Simplest | No progress for 8 minutes, exposed to timeouts, unclear outcome if the connection drops |
| **B. One POST whose response streams NDJSON events** | Single endpoint, live progress, no job store | No reattach if the CLI dies, long-lived connection |
| C. Async job with polling | Survives a CLI crash, the usual production pattern | Needs a second endpoint and a durable job store |
| D. Webhook callback | No open connection | The CLI would have to host a server |
| E. CLI splits the file and calls once per batch | Short requests, resume is natural | Pacing moves into the CLI, and the API still has to enforce the limit across calls |

### Decision

We chose **B**. The CLI POSTs the records and reads NDJSON events until the stream ends. NDJSON was preferred over SSE because the client is a CLI, not a browser, and one JSON object per line is simple to parse.

The stream must end with a `summary` event. A stream that ends without one is reported as an incomplete run, never as success. Heartbeat events keep the connection from looking idle during rate-limit waits and let the CLI detect a dead server.

### Consequences

- **Easier:** no job store or polling; the API owns the whole pipeline and the CLI stays thin.
- **Harder:** a run can't be resumed or reattached after a dropped connection.
- **Accepted risk:** on client disconnect the server stops processing, so an interrupted run is partially ingested. The events received so far show how far it got.
- **Shutdown:** on SIGTERM or SIGINT the server stops taking requests, and each run finishes its current batch and ends with a `run_failed` event, so the CLI can say why it stopped. After a grace period (30 seconds by default) it exits regardless. The rest of the run isn't resumed, so a deployment still interrupts long runs.

### Follow-ups

- C is the natural next step at scale: a durable queue and job store, plus a status endpoint.
- CLI-side resume, using the record of confirmed lines. Replay needs idempotency or deduplication keys, because the Analytics API doesn't promise idempotency.

---

## ADR-2: Apply the stricter reading of the rate limit

**Status:** Accepted

### Context

The sources disagree. The task says the Analytics Service is "rate limited at 20 messages per 10 seconds". The OpenAPI spec says "1 request per 10 seconds and the maximum number of 20 items per request".

### Decision drivers

- Going over the limit causes 429s and wasted retries.
- Staying within both statements means we don't have to guess which is right.

### Considered options

1. **Spec reading: one request of up to 20 items every 10 seconds.** Satisfies both statements. About 2 records per second.
2. PDF reading: 20 single-item requests per 10 seconds. Same throughput with more requests, and it breaks the spec's limit.

### Decision

We chose **option 1**, because it satisfies both sources. Batch size and interval are configuration. A 429 is still handled, because the limiter can't see other clients using the same key.

Trying the real service confirmed this reading. A second request right after the first got a 429, and so did one sent 3 seconds after a 20-item batch. A 21-item batch got a 400. The 429 has a `Retry-After: 10` header and an HTML body, neither of which is in the spec, so the client doesn't assume a 429 body is JSON and it honours the header.

The default interval is 10.5 seconds, not 10, so network jitter can't land a request just inside the previous window.

A full run of the sample against the real service took about 8.9 minutes and stored all 996 valid records. 2 of the 50 batches needed a second attempt. The logs at that point didn't record why, so retries now log their reason.

### Consequences

- **Easier:** batching follows directly, and it is the main performance approach.
- **Harder:** throughput is capped at about 2 records per second however fast enrichment is.
- **Accepted risk:** the limiter is in memory and per process, so running several API instances would break the limit.

### Follow-ups

- A shared limiter (for example Redis) before running more than one instance.

---

## ADR-3: Validate in the API, reject bad rows and never drop evidence

**Status:** Accepted, changed during implementation

### Context

The sample is dirty: about 20 spellings of 10 categories, a row with a missing column (line 105), an invalid IP (line 436), an empty category (line 675) and 3 repeated ids. The task doesn't say how to handle any of this. The data feeds incident response, so both losing records and mislabelling them are costly.

### Decision drivers

- Client input can't be trusted, even from our own CLI.
- Records must not be lost or changed silently.
- The tool has to be usable on the data SecOps actually has.

### Considered options

| Question | Options | Chosen |
|---|---|---|
| Where to validate | CLI, API, both | API. The CLI only parses, filters and reports parse errors |
| Messy categories | Reject anything inexact; fuzzy match; **explicit alias table** | Alias table. Rejecting would discard most of the file, and a fuzzy guess could mislabel an attack technique |
| Bad rows | Silently fix; drop; **reject and report** | Reject with line number and reason, written to a rejects file |
| Repeated ids | Drop; skip exact duplicates; **send and flag** | Send and flag |

### Decision

The API validates every record against allowlists (category, asset pattern, IP, safe-integer id), after canonicalising the category. Unknown values fail closed. Rejection reasons are fixed strings that never contain the input.

A shared `normaliseCategory()` is also used by the CLI, so that a category filter matches every spelling. The API runs it again itself.

Zod schemas are hand-written from `openapi.json` and stricter than it, because the spec has no `required` lists. A contract test checks them against the spec.

**Changed during implementation:** the plan was to skip rows identical in every field as exact duplicates. Building the wire contract showed the API doesn't receive `created_utc` or `source`, so it can't prove two rows are the same event. Every repeated id is now sent and flagged instead. The sample has no exact duplicates, so nothing changes for it.

### Consequences

- **Easier:** code past the validator works with typed, trusted data, and every row is accounted for.
- **Harder:** a new typo is rejected until someone adds it to the table. That is deliberate, and the rejects file makes it visible.
- **Accepted risk:** a truly duplicated row is stored twice, though the summary flags it. The asset pattern may reject an unusual but real name, which stays recoverable through the rejects file.

### Follow-ups

- Move the alias table into versioned configuration, and report how often each alias is used.
- Support ids beyond JavaScript's safe integer range.
- Generate types from `openapi.json` as a compile-time check on the schemas. Not done because the generator (`openapi-typescript`) needs TypeScript 5's compiler API, which TypeScript 7 doesn't have, and generated types alone would leave every field optional. The contract test covers most of this for now.

---

## ADR-4: Retry transient failures and isolate failures per record

**Status:** Accepted. Values may be tuned during implementation.

### Context

The Enrichment Service has "intermittent issues", possibly unresolved. Analytics documents 400, 429 and 500, and its 200 can report `status: "error"` or a partial `itemsIngested`.

### Decision drivers

- One bad record or a brief outage must not fail the whole file.
- Retries must not make an outage worse.
- Failures must be visible to the user.

### Considered options

1. Fail fast on any upstream error. Simple, but a flaky service would fail most runs.
2. Unlimited retries. Nothing fails visibly, but a run can hang forever.
3. **Bounded retries with exponential backoff and jitter, then mark the record or batch as failed.**

### Decision

We chose **option 3**, with these defaults, all configurable. Enrichment gets 5 attempts, with backoff starting at 200 ms and doubling, with full jitter, capped at 5 seconds. Analytics gets 3 attempts, paced by the rate limiter instead of a backoff. Timeouts are 5 seconds for enrichment and 10 seconds for analytics.

**Changed during implementation:** enrichment first ran through a small helper that limited it to 5 calls at a time. It was removed. Analytics accepts one batch every 10 seconds and an enrichment call takes about 30 ms, so enrichment speed doesn't change how long a run takes. Records are now enriched one group of 20 at a time, which already caps the calls. The cost is that a failed record leaves its batch short rather than being replaced, and each run can send up to 20 calls at once to a flaky service, so overlapping runs add up. A full run against the real service had no failed records with this setup. If analytics stopped being the bottleneck, bounded concurrency would be worth adding back.

**Changed during implementation:** the plan was 3 enrichment attempts. In a small test against the real service, 7 of 30 calls returned a 500 (about 23%). At that rate 3 attempts would lose about 1% of records, and 5 attempts less than 0.1%. It's a small sample, so the number is configurable.

| Failure | Behaviour |
|---|---|
| Enrichment 5xx, 429, timeout, network error or invalid 200 body | Retry. After the last attempt the record is marked failed, the rest continue, and it is never sent unenriched |
| Enrichment 400 | No retry, the record is marked failed |
| 401 or 403 from either service (not in the spec, but the real service returns 401) | The whole run stops with a `run_failed` event, since no other record can succeed. Batches already sent stay stored |
| Analytics 429 | Wait for `Retry-After`, then retry through the limiter |
| Analytics 5xx, timeout or network error | Retry through the limiter. If a later attempt succeeds, the batch is flagged as a possible duplicate. If not, it is marked failed and "may already be stored". Either way the exit code is 1 |
| Analytics 400 | No retry, the batch is marked failed |
| Analytics 200 with nothing stored | Retry, since nothing can be duplicated |
| Analytics 200 with partial `itemsIngested` | No retry, since it would duplicate items. Reported as a mismatch |
| Analytics 200 with `status: "error"` and items stored | No retry, the batch is marked failed and "may be partly stored" |
| Analytics 200 with an invalid body, or more items than were sent | No retry, since the batch may be stored. The batch is marked failed, and the count is not added to the total |

### Consequences

- **Easier:** runs survive brief failures, and the summary accounts for everything.
- **Harder:** a long outage means slow failure, as every record exhausts its retries.
- **Accepted risk:** the analytics response doesn't say which items failed in a partial ingestion, so the mismatch can only be reported per batch. The Analytics API has no idempotency key, so retrying after an unclear failure can store a batch twice. We chose at-least-once delivery: for incident response a flagged duplicate is better than a lost event, and the user is always told. Rows flagged this way, or marked "run did not finish", also appear in the rejects file, so rerunning that file as it is can create duplicates. The reason on each row says so.

### Follow-ups

- A circuit breaker for enrichment, so an outage fails fast.
- A retry input built from the rejects file.

---

## ADR-5: TypeScript, Hono and a single package

**Status:** Accepted

### Context

The work is almost entirely waiting on network calls, which Node's event loop handles well. CPU-heavy work would be a different question. The CLI and API share some code (the normaliser and wire contract).

### Decision drivers

- Streaming is central to the design.
- Code that is explicit and easy to review.
- Little setup, so the time goes into the actual problem.

### Considered options

| Question | Options | Chosen |
|---|---|---|
| Framework | NestJS, **Hono**, Express | Hono has first-class streaming and a small surface. NestJS's modules and DI container aren't justified by one endpoint |
| Layout | Workspace packages, **single package with folders** | Single package: no build step or workspace wiring, and `src/shared` can be extracted later |
| Dates | Hand-written parser, `new Date(string)`, **Luxon** | Luxon with an explicit UTC zone. `new Date` reads `01/02/2024` month-first, and our data is day-first |

Other tools: Zod (one definition for validation and types), commander (CLI), pino (structured logs), csv-parse, Vitest. Test style is table-driven for pure functions and Given/When/Then wording for behaviour over time.

### Decision

TypeScript on Node 26 LTS, Hono with plain constructor injection, one package with `src/shared`, `src/api` and `src/cli`. Dependency install scripts are denied by default (`allowBuilds` in `pnpm-workspace.yaml`), since nothing needs them to run.

### Consequences

- **Easier:** one toolchain, shared types and fast tests.
- **Harder:** the folder boundaries are a convention that the tooling doesn't enforce.
- **Accepted risk:** running through `tsx` instead of a compiled build is fine here, but a production deployment would add a build step.

### Follow-ups

- Move to a pnpm workspace when a second consumer of `src/shared` appears.
- Automated dependency updates.
