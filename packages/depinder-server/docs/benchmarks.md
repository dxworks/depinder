# Benchmarks

For whoever measures the service: where the bench lives. It is the monorepo's root `bench/`
project; this one has none of its own.

## End-to-end bench

`npm run bench` (at the monorepo root) runs depinder against this server and records how long it
takes and who fetched what; `npm run bench:compare` compares two runs. Everything about it is in
the root [bench/README.md](../../../bench/README.md).
