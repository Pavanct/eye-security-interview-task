# AGENTS.md

Conventions for anyone working in this repo, human or agent. See `README.md` for what the project does and `docs/decisions.md` for why.

## Commands

```bash
nvm use
pnpm install --frozen-lockfile
pnpm test        # unit and integration tests
pnpm typecheck
pnpm lint        # Biome: lint and format check. `pnpm format` applies fixes
pnpm api         # needs UPSTREAM_API_KEY in .env
pnpm -s cli ingest <file>
```

Running the CLI against the default upstream writes real data to the Analytics Service. Use the tests when you don't need the real service.

## Layout

- `src/shared/`: the wire contract and category normaliser, used by the CLI and the API
- `src/api/lib/`: retry, rate limiter, sleep. No business knowledge
- `src/api/upstream/`: the two external services
- `src/api/ingest/`: validation and the pipeline
- `src/api/service.ts`: all the wiring
- `src/cli/`: parsing, filtering, the API client, reporting
- `test/integration/`: full-flow tests

## Conventions

- **Errors are values at I/O boundaries.** Clients return outcomes instead of throwing, so each failure has to be handled.
- **Every row stays accounted for.** A change must not let a record disappear without a counter or a reason.
- **Only a final `summary` means a run finished.** Never report success without one.
- **Pass dependencies in** by hand, and keep interfaces small and defined where they're used.
- **Comments explain why,** not what.
- **Tests:** unit tests sit next to the code. Use tables for pure functions, and Given/When/Then wording for behaviour over time. Fake only the external services, at the network boundary.
- **Commits:** Conventional Commits, one feature or fix per commit, with its tests.

## Security rules

- Never log raw row values or the API key. Rejection reasons are fixed strings.
- Treat CSV content as hostile. Validate against allowlists, and fail closed on unknown values.
- Keep secrets in `.env`, which is gitignored.

## Keep docs in step

If a decision changes, update its entry in `docs/decisions.md` and say why.
