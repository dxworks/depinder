# bench — end-to-end benchmark

Runs depinder (`packages/depinder-cli/dist/`) against the server (`packages/depinder-server`) and
records how long it takes and who fetched what: depinder's own registry lookups versus the
server's. Rerunnable; every run lands in its own folder under `bench/runs/` (git-ignored), and two
runs can be compared. It is the Nx project `depinder-bench` (tag `scope:bench`); all commands below
run at the monorepo root.

Nothing here imports from `packages/`: the bench runs the CLI as a program, talks to the server over
HTTP, to its Postgres with `pg` and plain SQL, and to Docker / SSH through their CLIs.

## Run

```bash
npm run bench -- --target dev --label baseline              # asks you to type "wipe"
npm run bench -- --target dev --label baseline --yes        # no question
npm run bench -- --cells warm-server,warm-both --repeats 5  # no wipe: needs a filled server
npm run bench -- --cells no-server --now 2026-10-03T08:00:00.000Z   # no wipe, no resolver
npm run bench:compare -- bench/runs/<A> bench/runs/<B>
npm run bench:compare -- <A> <A> --pair no-server:warm-server     # one cell against another
npm run bench:reset -- --target dev                         # just the wipe
```

A full run (both producers, all cells but no-server, 3 repeats) takes about 15–25 minutes, most of
it the empty cells and the drain after them; each no-server run is about as slow as an empty one.

Nothing waits without a limit: `docker compose up` (5 min, `build` 30), health (10 min), each
depinder run (`--run-timeout-min`), the drain (`--drain-timeout-min`), every SQL query (2 min).
Long waits print a progress line at least every minute, so it is safe to run in the background:
`npm run bench -- --yes ... < /dev/null > bench.log 2>&1 &` and `tail bench.log`.

| option | default | |
|---|---|---|
| `--target dev\|deploy\|hosted` | `dev` | see below |
| `--producers` | `trivy,syft` | the SBOM folders under the input dir, run one after the other |
| `--cells` | `empty,warm-server,warm-both,no-server` | always run in this order |
| `--repeats N` | 3 | runs per warm and no-server cell; summary shows the median |
| `--label` | `run` | the run folder is `<YYYY-MM-DD_HHMM>-<label>` |
| `--now <ISO>` | the bench's start | the date every depinder run measures ages from (below) |
| `--yes` | | skip the typed confirmation before a wipe; required when stdin is not a terminal (a wipe without it then stops before touching anything) |
| `--allow-wipe-nondev` | | needed (with or without `--yes`) to wipe `deploy` or `hosted` |
| `--rebuild` | | `docker compose build` before `up` (local targets) |
| `--build-depinder` | | `npx nx build depinder-cli` in depinder first |
| `--keep-caches` | | keep the per-run SQLite caches (deleted otherwise) |
| `--drain-timeout-min` | 20 | how long to wait for the server's queue after an empty run |
| `--run-timeout-min` | 45 | a depinder run still going after this is killed (recorded as failed) |

Paths: the CLI is `packages/depinder-cli` and the server `packages/depinder-server` of this
monorepo; the input is `../input_data/zzw-v051-rerun/depminer/results` next to the monorepo (`trivy/`
and `syft/`), overridable with `BENCH_INPUT_DIR`.

### Targets

| target | stack | env file (database, token) | wipe needs |
|---|---|---|---|
| `dev` | local compose in `packages/depinder-server`, `http://localhost:8080` | `packages/depinder-server/.env` (the dev database) | confirmation |
| `deploy` | local compose + `bench/compose.deploy-db.yml` | `packages/depinder-server/deploy/.depinder.server.env` | confirmation + `--allow-wipe-nondev` |
| `hosted` | the server at `BENCH_URL` (required); resolver stopped/started with `ssh depinder depinder stop\|start resolver` | `packages/depinder-server/deploy/.depinder.server.env` | confirmation + `--allow-wipe-nondev` |

For the local targets the bench runs `docker compose up -d` with the target's files first. That is
idempotent, and recreates the containers when the env file differs from what they run on, so
switching targets moves the stack to the right database. Then it waits for `/health` and
`/vuln/health`. It warns (does not fail) when the image is older than the last commit touching
`packages/depinder-server` or anything under its `src/`; pass `--rebuild` then. **Only one stack per database**: don't bench `deploy`
while the hosted server runs on the same database.

Secrets: env files are parsed into an object, never into the bench's environment, and never
printed. Of `DATABASE_URL` only a masked host is shown (`dev database (***.example.com)`: the
target and the host's last two labels), in the output, run.json and summary.md alike; driver errors
are printed with the host and user masked. The token goes only into depinder's environment,
as `DEPINDER_RESOLVER_TOKEN`.

### Preflight

- depinder-cli's `dist/` exists and is not older than its `src/` (else it stops; `--build-depinder`
  builds), its branch is `feature/depinder-rework` (warns otherwise).
- The token is at least 16 characters.
- Trivy and Grype are not needed locally: vulnerabilities come from the vuln server, whose health
  and database builds are recorded.
- Without `empty` but with a warm cell in `--cells`, the server must already be filled: packages > 0,
  nothing pending, queue empty. Otherwise it refuses. `no-server` alone needs only the vuln server.

depinder runs with `GH_TOKEN`, `GH_TOKEN_*`, `GITHUB_TOKEN`, `DATABASE_URL` and
`DEPINDER_RESOLVER_*` removed from its environment (no GitHub advisory calls, no stray resolver),
its own SQLite cache (`DEPINDER_CACHE_DB`) and `--profile`.

### The fixed "now"

Now-Used, Now-latest, the Out of Support counts and Operational Risk measure age from "today", so
they would change by themselves between two runs. Every depinder run of a bench gets one fixed
date as `DEPINDER_REPORT_NOW`: `--now`, or the bench's start time. It touches nothing else in
depinder (cache freshness, `max_age`, logs keep the real clock). It is written to `run.json`
(`reportNow`) and `summary.md`, and the bench ends by printing the `--now` to reuse: **every run
compared with a reference run must pass the reference's `--now`**. The compare prints both dates
and warns when they differ.

## Cells

Per producer, trivy first, then syft:

1. **empty** — the worst case. The bench shows the (masked) database host and its counts, (asks once for
   the whole run), stops the resolver, truncates `package`, `package_version`, `fetch_queue`,
   `fetch_log` and `registry_feed`, checks they are empty, starts the resolver (which also drops
   the API's in-memory version cache) and waits until it is healthy. Then one depinder run with an
   empty local cache. Afterwards it waits until the server has drained (no `pending` package, empty
   `fetch_queue`), polling every 10 s. Each producer gets its own wipe, so syft starts from an empty
   server too.
2. **warm-server** — the server holds this producer's packages, depinder starts with an empty local
   cache each time. Repeated N times.
3. **warm-both** — repeat *i* reruns on the cache warm-server repeat *i* left: local SQLite warm
   and server warm. Repeated N times.
4. **no-server** — depinder with `--no-resolver` and an empty local cache: it fetches every package
   from the registries itself (its old fallback). Vulnerabilities still come from the vuln server
   (`--vuln-server`), so only the registry path differs from the other cells; a local scan would
   bring other scanner versions and database builds into the diff and the timing. It never talks
   to the resolver, so it does not change the server's database. Repeated N times. summary.md adds
   its registry lookups and enrich time per ecosystem.

## What a run folder holds

```
bench/runs/2026-10-02_1430-baseline/
  run.json        label, target, url, masked database host, git SHA/branch/dirty of the monorepo, image
                  Created, /vuln/health body, node, load average around every run, options,
                  reportNow (the fixed "now")
  results.jsonl   one line per depinder run: wall, exit code, every profile phase and counter,
                  the picks below, and for empty runs the server's numbers
  summary.md      the tables below (also printed at the end)
  logs/<cell>-<producer>[-i].log    depinder's full output
  out/<cell>-<producer>[-i]/        depinder's CSV output
  caches/         SQLite caches, deleted at the end unless --keep-caches
```

## Reading summary.md

**Timings** — one row per cell/producer, `median (min–max)` over repeats, seconds:

- `wall` — spawn to exit of `depinder analyse`.
- `resolve:bulk` — depinder asking the resolver for every purl (phase 2).
- `vuln:server` — the vuln server's answer.
- `max enrich:*` — the slowest plugin's enrich phase (they run side by side), which is where
  depinder fetches from registries itself.
- `blackduck:*` — sum of the Black Duck export phases.
- `registry:fetch` — registry lookups depinder made itself (one per library).
- `cache:hit` / `cache:miss` — depinder's local cache.

**Empty server** — per producer:

- *purls asked* — everything depinder sent the resolver (sum of its five answers).
- *server answered* — depinder's `resolver:*` counters: resolved, not-found, refreshing (served
  stale while refreshed), *pending at deadline* (not fetched in time), error.
- *depinder fetched itself* — `registry:fetch`, next to `pending + refreshing + error`, the purls
  the server had no usable answer for. They differ because one library can have several purls, and
  a lookup can fail (`registry:error`).
- *server fetched* — packages the server settled as `resolved` or `not_found` with `fetched_at` while
  depinder ran, and from depinder's start until the drain ended. *server HTTP requests* counts
  `fetch_log` rows over the same windows (feed polls have no package and are counted apart).
- *drain* — seconds from depinder's exit until nothing was pending or queued. Feeds can queue news
  for a tracked package at any moment, so this is the first moment it was empty.
- The per-type table lines depinder's lookups (its ecosystems mapped to purl types: java→maven,
  go→golang, ...) against what the server fetched.

## Comparing two runs

`npm run bench:compare -- <A> <B> [--pair <cellA>[@N]:<cellB>[@N]]...` prints:

1. median wall per cell/producer, with the change in seconds and percent;
2. counters whose median differs, warm cells only (an empty cell depends on the registries' mood);
3. the CSV output of the first run of each cell present in both, row by row (rows matched by key —
   project, library, version, component, vulnerability — not position), column by column, with up to
   10 examples per column. The `Project path` column of `security.csv` / `_vulnerability_details.csv`
   is ignored. `Now-Used` and `Now-latest` are compared when both runs share a fixed `reportNow`, and
   ignored (with a warning) when the dates differ or a run has none.

`--pair` replaces the same-cell matching: cell A of run A against cell B of run B, per producer,
on the first run unless `@N` names a repeat (timings then use that repeat alone). A and B may be the
same run: `--pair warm-server@1:warm-server@2` checks determinism, `--pair no-server:warm-server`
shows what depinder's own fallback gets differently. Counters are not compared for a pair.

A is the reference. Every CSV difference is sorted by the regression rules of the monorepo plan
(`NX_MIGRATION.md`, section 6), in `lib/allowed-differences.ts`:

- **newer release** — the row's library has a version that B's kept SQLite cache dates after A's
  `startedAt` (run.json), and the row differs only in Latest Version, its release date,
  Latest-Used, Now-latest, Newer Versions (and semver), Operational Risk, or the libs CSV's
  Licenses together with a new Latest Version. An ecosystem's project stats follow when it has such
  rows, its licenses summary when such rows changed a library's Licenses. Needs B's caches (`--keep-caches`); without them nothing is labelled.
- **vulnerability database** — a vulnerability column, or a row of `security.csv`,
  `_vulnerability_details.csv` or `_upgrade_guidance.csv`, when the two runs' vuln databases (the
  `built_at` of each in run.json) differ.
- **regression** — everything else, listed first in each column's examples.

The last line is the verdict: `VERDICT: identical — ...` when the CSVs and the warm counters match,
`VERDICT: allowed differences only — ...` when every CSV difference is a newer release or a
vulnerability database change, `VERDICT: DIFFERENT — ...` otherwise (timings are reported, never
judged: the largest change in percent is on the line). A run can be named by its folder name alone
(looked up under `bench/runs/`). The exit code is always 0.

## Micro benches

The server's narrow benches stay in its project, `packages/depinder-server/bench/micro/`:
`bench-stream.cjs` (one /resolve read as a stream) with `bench-http.cjs` and `bench-chunks.cjs` on
top of it, and the vuln server's `vuln-parity.ts`, `vuln-bench.cjs` and `vuln-soak.cjs` (usage in
[its docs/benchmarks.md](../packages/depinder-server/docs/benchmarks.md)). `vuln-parity.ts` imports
the server's `src/vuln/merge/` to check the answer field by field.
