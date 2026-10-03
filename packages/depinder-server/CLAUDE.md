# depinder-server-side

The purl resolver (versions, release dates, licenses for eight ecosystems) and the vulnerability
server that depinder calls. What it does and how: [README.md](README.md) and [docs/](docs/).

## Layout and the import rule

```
src/main.ts      ROLE switch: api, worker, all, vuln
src/shared/      config, errors, logging, purl, the fastify plumbing both servers use
src/resolver/    api/, db/, registries/, worker/ (Postgres-backed)
src/vuln/        POST /vulnerabilities: Trivy + Grype, no Postgres
test/            mirrors src/; recorded registry answers in test/fixtures/
bench/           end-to-end bench (run.ts, compare.ts) and micro benches in bench/micro/
```

- `shared` <- `resolver`, `shared` <- `vuln`. Never `vuln` -> `resolver`, and `shared` imports
  neither.
- `bench/` does not import `src/`; the one exception is `bench/micro/vuln-parity.ts`, which
  checks `src/vuln/merge/`.

## Size targets

Code files ~350 lines at most, functions ~100, test files ~500 (fixtures exempt). Split along
the seams that are already there before going over. `test/architecture.test.ts` enforces the
import rule and hard ceilings of 400 lines (src/) and 550 (test/).

## Commands

```bash
npm run typecheck
npm test                 # no network, no database; DB integration tests are skipped
TEST_DATABASE_URL=postgresql://postgres:depinder@127.0.0.1:55432/depinder npm test
                         # the same plus the integration tests, on the depinder-pg container
npm run build            # -> dist/
npm run bench -- --target dev --label <name>
npm run bench:compare -- bench/runs/<A> bench/runs/<B>
```

Starting depinder-pg: [docs/development.md](docs/development.md). Bench targets, cells and
output: [bench/README.md](bench/README.md). Run typecheck, both test runs and the build before
every commit.

## Commits

- Commit only; never push. Stage files explicitly.
- No attribution of any kind: no Co-Authored-By, no "Generated with", no mention of Claude or AI.
- Imperative subject, wrapped body that says why.

## Secrets

- Never read or print env files (anything `.env*` other than `.env.example`, and
  `deploy/.depinder.server.env`).
- A hook blocks any Bash line that names `.env` together with cat, grep and the like, commit
  messages included; write messages to a file and use `git commit -F`.

## The resolver database

No seeding. It fills on request and stays fresh from the feeds; never import depinder's cache or
any other bulk data into it.
