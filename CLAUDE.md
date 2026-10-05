# depinder — working agreements

The depinder Nx monorepo (npm workspaces, Node 24). The plan it follows: `../NX_MIGRATION.md`.
Project notes: [packages/depinder-cli/CLAUDE.md](packages/depinder-cli/CLAUDE.md) (CLI, incl. open
items) and [packages/depinder-server/CLAUDE.md](packages/depinder-server/CLAUDE.md) (server
layout, its import rule, its commands).

## Layout

```
packages/depinder-cli/      app, scope:client  -> npm @dxworks/depinder (esbuild bundle, CommonJS)
packages/depinder-server/   app, scope:server  -> Docker image + deploy kit (ESM)
bench/                      depinder-bench, scope:bench: end-to-end bench (CLI runs, HTTP, SQL)
tools/workspace-checks/     size guard, single-version dependency check, function-size lint config
```

- The CLI and the server never import each other. `bench/` never imports `packages/`: it runs the
  CLI as a program and talks to the server over HTTP and to its Postgres with plain SQL.
- Coming (plan phases 3+): `packages/depinder-core` (scope:shared) and `packages/parity`.
- One version of every dependency in the workspace (`workspace-checks:dependency-check`); one test
  runner, vitest, everywhere.

## Size targets (new and moved code)

Code files ~350 lines (hard 400), functions ~100, test files ~500 (hard 550; fixtures exempt).
Split along existing seams before going over. `workspace-checks:size-guard` measures every file in
the repo; `lint` measures functions. Files that were already over a limit are listed in
`tools/workspace-checks/size-baseline.json` and may shrink but never grow. Suggestive names;
comments short and summarising, never restating the code.

## Commands

```bash
npm ci
npm run check                               # typecheck, lint, test, build, size guard, dependency check
npx nx test-integration depinder-server     # + Postgres tests on the depinder-pg container
npx nx docker-build depinder-server         # the server image; build context is this root
npm run bench -- --target dev --label <name> [--now <ISO>] [--keep-caches]
npm run bench:compare -- <runA> <runB> [--pair cellA:cellB]
npm run bench:reset -- --target dev
```

Every phase/commit ends green: typecheck, unit tests, integration tests, builds. The local dev
stack (resolver, vuln, caddy) runs from `packages/depinder-server` with `docker compose up -d`.

## Integration test database

The Docker container `depinder-pg` (Colima), port 55432:
`TEST_DATABASE_URL=postgresql://postgres:depinder@127.0.0.1:55432/depinder`. Start it as in
`packages/depinder-server/docs/development.md`. Throwaway data only.

## The resolver database

Never seeded. It fills on request and stays fresh from the registry feeds; never import depinder's
SQLite cache or any other bulk data into it. Only the bench wipes the dev database (`bench:reset`,
the bench's empty cell), and never the deployed one without `--allow-wipe-nondev`.

## Secrets

- Never read, print, grep, source or parse env files (`.env`, `.env.*`, `*.env` other than
  examples; `packages/depinder-server/.env`, `packages/depinder-server/deploy/.depinder.server.env`),
  not even key names, not via scripts or other agents. When a setting matters, ask Alex.
- A hook blocks any Bash line that names `.env` together with cat, grep and the like, commit
  messages included: write messages to a file and use `git commit -F`.
- The production server's IP, database passwords, database hosts and the Supabase project refs
  never go into the repo (code, docs, examples, commit messages). The deploy kit takes the IP from
  `DEPINDER_SERVER_IP` or `--ip`. `.gitignore` ignores every env-style file at any depth unless
  its name contains "example".
- `deploy/.depinder.server.env` lives in 1Password, never in the repo.

## Commits and pull requests: no Claude attribution

Commit only; never push unless Alex says so. Stage files explicitly. Imperative subject, wrapped
body that says why.

Never say a commit or PR was made with Claude or Claude Code: no `Co-Authored-By: Claude …`
trailer, no "Generated with Claude Code" line, no mention in the text. Applies to every commit and
every PR in this repo (and in the archived depinder-server-side).

No hand-off documents: Alex carries the context between phases.

---

## Graphify MCP: the user is new to this tool — narrate everything

**Alex has never used Graphify before and is still forming a mental model of it.**
Treat every interaction with the `graphify` MCP server as a teaching moment, not a
silent internal step. Verbosity here is the point, not noise.
