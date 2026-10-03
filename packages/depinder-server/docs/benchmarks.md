# Benchmarks

For whoever measures the service: where the end-to-end bench lives, and how to run the micro benches
in `bench/micro/` (this project's folder; the end-to-end bench is the monorepo's root `bench/`).

## End-to-end bench

`npm run bench` (at the monorepo root) runs depinder against this server and records how long it
takes and who fetched what; `npm run bench:compare` compares two runs. Everything about it is in
the root [bench/README.md](../../../bench/README.md).

## Micro benches

The `/resolve` ones read the stream with `bench/micro/bench-stream.cjs`, which asks for `br, gzip`
as depinder does. Each file's header comment has its usage line:

- `bench/micro/bench-http.cjs` — one `POST /resolve` end to end, saving the body.
- `bench/micro/bench-chunks.cjs` — the bulk chunks of a real run, sequential then concurrent.
- `bench/micro/vuln-parity.ts`, `vuln-bench.cjs`, `vuln-soak.cjs` — the vulnerability server; below.

## Parity, bench and soak

All three need Phase 0's folder (`P0`): `purls.txt`, Trivy's and Grype's output for it
(`t-all.json`, `g-all.json`), and its frozen databases. Parity and the bench must run the server in
frozen mode on them (`TRIVY_CACHE_DIR=$P0/db/trivy`, `GRYPE_DB_CACHE_DIR=$P0/db/grype`); the soak
runs against either mode.

```bash
VULN_URL=http://localhost:8080 RESOLVER_API_TOKEN=... P0=... npx tsx bench/micro/vuln-parity.ts
VULN_URL=http://localhost:8080 RESOLVER_API_TOKEN=... P0=... node bench/micro/vuln-bench.cjs
VULN_URL=http://localhost:8080 RESOLVER_API_TOKEN=... P0=... SOAK_SECONDS=600 SOAK_CONCURRENCY=2 node bench/micro/vuln-soak.cjs
```

`vuln-parity.ts` posts the 10,049 purls in chunks of 2,000, five at once, and checks the answer
against Phase 0: every (purl, id) pair of each tool, then the whole map, every field, against the
same merge run locally over Phase 0's output. It exits non-zero on any difference and prints the
answer's sizes. `vuln-bench.cjs` sends the same purls as 1, 2, 3, 5 and 10 chunks at once and prints
the median wall time, the 503s and the longest wait for a slot; start the server with
`VULN_MAX_PURLS=20000` for it, or the one- and two-chunk rows are 413s.

`vuln-soak.cjs` keeps the server busy with 2,000-purl chunks while it switches databases, and
prints each build the answers name the first time it appears, then every non-200; it exits non-zero
if there was any. Measured on the laptop with Phase 0's builds seeded in managed mode: 130 requests
in 120 s, two at a time, 0 non-200; Trivy's newer build was installed 5 s in, the answers moved to
it, and the old folder was deleted 0.3 s later, when the two scans still reading it ended.
