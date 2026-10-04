# depinder-server

The purl resolver (versions, release dates, licenses for eight ecosystems) and the vulnerability
server that depinder calls: the Nx project `depinder-server` (tag `scope:server`) of the depinder
monorepo. What it does and how: [README.md](README.md) and [docs/](docs/). The monorepo-wide
agreements (commits, secrets, sizes, the resolver database) are in the root `CLAUDE.md`.

## Layout and the import rule

```
src/main.ts      ROLE switch: resolver-api, resolver-worker, resolver, vuln
src/shared/      config, errors, the fastify plumbing both servers use (purls and logging: @depinder/core)
src/resolver/    api/, db/, registries/ (feeds, polls, limits), worker/ (Postgres-backed)
src/vuln/        POST /vulnerabilities: Trivy + Grype, no Postgres
test/            mirrors src/; recorded feed answers in test/fixtures/ (the fetchers' are in core)
bench/micro/     the server's micro benches (the end-to-end bench is the root bench/ project)
deploy/          the deploy kit (Hetzner, compose.server.yml); the server address only from
                 DEPINDER_SERVER_IP or --ip, never in a file
```

- `shared` <- `resolver`, `shared` <- `vuln`. Never `vuln` -> `resolver`, and `shared` imports
  neither.
- `bench/micro/` does not import `src/`; the one exception is `bench/micro/vuln-parity.ts`, which
  checks `src/vuln/merge/`.
- The root `bench/` never imports this project: it talks to the server over HTTP and SQL.

## Size targets

Code files ~350 lines at most, functions ~100, test files ~500 (fixtures exempt). Split along
the seams that are already there before going over. `test/architecture.test.ts` enforces the
import rule and hard ceilings of 400 lines (src/) and 550 (test/); the workspace size guard and
`nx lint depinder-server` (function length) check the same limits repo-wide.

## Commands

From the monorepo root:

```bash
npx nx typecheck depinder-server
npx nx lint depinder-server
npx nx test depinder-server              # no network, no database; DB integration tests are skipped
npx nx test-integration depinder-server  # the same plus the integration tests, on the depinder-pg
                                         # container (TEST_DATABASE_URL=postgresql://postgres:depinder@127.0.0.1:55432/depinder)
npx nx build depinder-server             # -> packages/depinder-server/dist/
npx nx docker-build depinder-server      # the image; the build context is the monorepo root
npm run bench -- --target dev --label <name>
npm run bench:compare -- bench/runs/<A> bench/runs/<B>
```

Every registry bug gets a fixture case (`npm run record-fixture-case -w @depinder/core`): the
parity test (`packages/parity`, `npx nx test-parity parity` with TEST_DATABASE_URL) then guards
this server and the CLI's fallback at once.

Starting depinder-pg: [docs/development.md](docs/development.md). Bench targets, cells and
output: the root `bench/README.md`. Run typecheck, lint, both test runs and the build before every
commit. The local stack runs from this folder: `docker compose up -d` (env from `.env` here).

## Commits

- Commit only; never push. Stage files explicitly.
- No attribution of any kind: no Co-Authored-By, no "Generated with", no mention of Claude or AI.
- Imperative subject, wrapped body that says why.

## Secrets

- Never read or print env files (anything `.env*` other than `.env.example`, and
  `deploy/.depinder.server.env`).
- A hook blocks any Bash line that names `.env` together with cat, grep and the like, commit
  messages included; write messages to a file and use `git commit -F`.
- The production server's address, database passwords and Supabase project refs never go into
  the repo, examples and docs included.

## The resolver database

No seeding. It fills on request and stays fresh from the feeds; never import depinder's cache or
any other bulk data into it.
