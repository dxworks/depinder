# Vulnerabilities (`ROLE=vuln`)

For clients and operators of the vulnerability server: its API, concurrency, health, and how it
keeps its databases fresh. The parity, bench and soak checks are in [benchmarks.md](benchmarks.md).

A second server in the same image: purls in, Trivy and Grype findings out. Depinder scans every
SBOM with both tools on the machine it runs on; this lets it send the purls instead and get the
findings back from databases kept in one place, with the local scanners as its fallback. It is a
separate process with its own config and **no Postgres** — `DATABASE_URL` is neither read nor
required — and it shares only the token, the port and the log level with the resolver.

The purls are written into a dummy CycloneDX file, one `library` component each, named the way
Trivy's own SBOMs name them (maven and npm: group and name; composer and golang: the whole path as
the name), and both scanners read that file side by side. Phase 0 checked the approach against
scanning the real SBOMs: the same 1,329 Trivy and 1,326 Grype findings. The merge of the two tools'
findings is depinder's own (`src/plugins/sbom/local-scan.ts`), ported as is; a finding is tied back
to the purl that was sent by the component's `bom-ref`, which both tools echo, never by the purl
they echo, which is their own spelling (Trivy lowercases a golang path).

A scan never updates its database (Trivy runs with `--skip-db-update`, Grype with
`GRYPE_DB_AUTO_UPDATE=false`). Where the databases come from depends on the mode:

- **managed** — `VULN_DATA_DIR` is set: the server downloads both databases there and keeps them
  current itself, with no cron job (see [Keeping the databases fresh](#keeping-the-databases-fresh)).
- **frozen** — `TRIVY_CACHE_DIR` and `GRYPE_DB_CACHE_DIR` are set: someone else's folders, read as
  they are and looked at on every request with a `stat`, so a database swapped in place is used by
  the next scan. This is what keeps `bench/micro/vuln-parity.ts` and the bench repeatable: same data, same
  answer.

Both or neither is a configuration error. A missing scanner binary stops the process at startup;
missing databases do not — the server starts and answers 503 until they are there.

| variable | default | meaning |
|---|---|---|
| `ROLE` | — | `vuln` |
| `RESOLVER_API_TOKEN` | — | **required**, at least 16 characters. The same token and checks as the resolver |
| `PORT`, `LOG_LEVEL` | `8080`, `info` | as for the resolver |
| `TRIVY_BIN` / `GRYPE_BIN` | `trivy` / `grype` | the binaries |
| `VULN_DATA_DIR` | — | managed mode: where the server keeps the databases. **One of this or the two below is required** |
| `TRIVY_CACHE_DIR` | — | frozen mode: Trivy's `--cache-dir`, the folder with `db/trivy.db` and `db/metadata.json` |
| `GRYPE_DB_CACHE_DIR` | — | frozen mode: the folder with `6/vulnerability.db` |
| `VULN_MAX_PURLS` | `5000` | distinct purls per request, 1..50000. Past it: 413 |
| `VULN_MAX_SCANS` | half the cores | scans running at once, 1..64. Each scan is one Trivy and one Grype |
| `VULN_MAX_QUEUED` | 4 × `VULN_MAX_SCANS` | requests that may wait for a scan, 0..1000. Past it: 503 busy |
| `VULN_SCAN_TIMEOUT_MS` | `60000` | one scanner run before it is killed, 1000..600000 |
| `VULN_TMP_DIR` | the OS temp dir | where each scan's `depinder-vuln-*` folder goes |
| `VULN_TRIVY_STALE_HOURS` / `VULN_GRYPE_STALE_HOURS` | `24` / `72` | past this age a build is reported `stale` (and still served), 1..8760 |

The settings of managed mode are under [Keeping the databases fresh](#keeping-the-databases-fresh).

```bash
ROLE=vuln RESOLVER_API_TOKEN=... VULN_DATA_DIR=/var/lib/vuln npm run dev
ROLE=vuln RESOLVER_API_TOKEN=... TRIVY_CACHE_DIR=/var/lib/trivy GRYPE_DB_CACHE_DIR=/var/lib/grype npm run dev
```

## `POST /vulnerabilities`

```json
{"purls": ["pkg:npm/%40babel/core@7.12.9", "pkg:golang/github.com/Masterminds/goutils@v1.1.0", "pkg:npm/lodash"]}
```

```json
{
  "vulnerabilities": {
    "pkg:npm/%40babel/core@7.12.9": [{"severity": "LOW", "score": 3.2, "identifiers": [{"value": "CVE-2026-49356", "type": "CVE"}, {"value": "GHSA-4x5r-pxfx-6jf8", "type": "GHSA"}], "source": "trivy,grype", ...}],
    "pkg:golang/github.com/Masterminds/goutils@v1.1.0": [...]
  },
  "unsupported": [{"purl": "pkg:npm/lodash", "reason": "no_version"}],
  "databases": {
    "trivy": {"built_at": "2026-10-01T19:00:16.340316472Z", "schema": "2", "age_seconds": 6449, "stale": false},
    "grype": {"built_at": "2026-10-01T06:33:48Z", "schema": "v6.1.9", "age_seconds": 51238, "stale": false}
  },
  "scanners": {"trivy": "0.74.0", "grype": "0.118.0"}
}
```

- Keys are the purls **exactly as sent** — encoding, case and qualifiers kept. Exact duplicates are
  scanned once.
- Findings are depinder's `Vulnerability` shape, field for field.
- **A purl that was scanned and is not under `vulnerabilities` is clean.** Only vulnerable purls are
  listed.
- `unsupported` lists what was not scanned: `invalid` (not a purl, or a maven purl with no group),
  `unsupported_type` (not one of the eight ecosystems), `no_version`.
- `databases` and `scanners` say what produced the answer: the same purls can legitimately get
  different findings once a database is newer. Both scanners of one request read exactly the builds
  named here, even if a newer one was installed while they ran. `age_seconds` is the build's age at
  the moment of the scan, and `stale` says it is past `VULN_*_STALE_HOURS`: old data is served and
  labelled, never refused, and the caller decides what to make of it.
- `Server-Timing` carries the time spent waiting for a slot, in Trivy, in Grype, and in all.

| status | when |
|---|---|
| 200 | the answer above; also when nothing was scannable, without a scan |
| 400 | the body is not `{"purls": [string, ...]}` |
| 401 | no or wrong token |
| 413 | more than `VULN_MAX_PURLS` distinct purls; `{"error", "max"}` |
| 503 `{"error": "busy"}` | every scan slot taken and the waiting line full; `Retry-After: 1` |
| 503 `{"error": "databases not ready", "reason"}` | a tool has no usable build: in managed mode only until its first download is in (`"reason": "grype: downloading"`), in frozen mode while a file is missing or unreadable |
| 500 `{"error": "scan failed", "scanner", "reason"}` | a scanner exited non-zero (its verdict line is in `reason`), timed out, or printed something that is not its report |

Measured on a 10-core laptop with Phase 0's databases: Grype is the slow one, at about 0.85 s to
open its database plus ~0.45 ms per purl; 2,000 purls take ~2 s, 5,000 ~3 s. Answers are small next
to the resolver's: 490 KB raw for 2,000 purls (86 KB br), 990 KB for 5,000 (139 KB br).

## Concurrency

At most `VULN_MAX_SCANS` scans run at once; up to `VULN_MAX_QUEUED` more requests wait in arrival
order, and past that a request is refused at once with 503 busy rather than parked behind work it
cannot see the end of. A caller that hangs up leaves the line, or has its scan killed. On the
laptop, 10,049 purls finished fastest as five chunks at once (2.5 s; one chunk 5.4 s, ten 3.8 s).

The default is half of `os.availableParallelism()`, and **inside a container that can read the
host's cores rather than the container's share**: set `VULN_MAX_SCANS` explicitly when deploying,
from `bench/micro/vuln-bench.cjs` run on that machine.

## `GET /health`

`{"status": "ok", "scans": {"running", "queued"}, "databases": {"trivy": {...}, "grype": {...}}}`.
Unauthenticated.

- `status` is `ok`, or `stale` when a build is past its stale age — **still 200**: a restart cannot
  make an upstream publish, so the health check must not trigger one.
- 503 `{"status": "not_ready", "reason", "databases"}` only while a tool has no usable build at all.
- Each tool has its build (`built_at`, `schema`, `age_seconds`, `stale`) and, in managed mode, what
  its update loop is doing: `updating`, `last_check_at`, `last_ok_at`, `last_error`,
  `next_check_at`, `upstream_built_at` (what the publisher says its newest build is).

## Keeping the databases fresh

In managed mode the server keeps both databases current itself. Each tool has its own loop, so a
hung Grype download never delays a Trivy update. Every `VULN_DB_CHECK_INTERVAL_MIN`, and once right
after boot:

1. **Check** — one small HTTP read of the publisher's metadata, which writes nothing: the
   `trivy-db:2` OCI manifest's database layer digest (anonymous; mirror.gcr.io answers directly,
   ghcr.io after an anonymous token), and Grype's `latest.json` checksum and `built`. Same identity
   as the current build → done. We decide, not the tools: Trivy's own rule fetches only once
   `NextUpdate` (build + 24 h) has passed, against a publish every ~6 h, and `grype db check`
   writes into the folder it checks.
2. **Disk** — less than twice a build's size free (3.2 GB for Trivy, 6.6 GB for Grype) → skipped
   with `low disk`, tried again on the next tick.
3. **Download** — by the tool itself, into a fresh `staging/` folder: `trivy image
   --download-db-only --db-repository $TRIVY_DB_REPOSITORY --cache-dir <staging>` and `grype db
   update` with `GRYPE_DB_CACHE_DIR=<staging>` and `GRYPE_DB_UPDATE_URL`. Killed after
   `VULN_DB_DOWNLOAD_TIMEOUT_MS`.
4. **Newer** — the build time the database reports (Trivy's `metadata.json`, `grype db status`)
   must be later than the current build's. If not, the download is thrown away and its identity
   remembered, so it is not fetched again.
5. **Smoke test** — 22 canary purls in six ecosystems (`src/vuln/canaries.ts`), each one that both
   tools flagged in Phase 0, scanned with that tool's normal scan command against the new build.
   It must exit 0, find every canary's id, and find at least 90 % of the current build's total on
   the canaries: a truncated database can still have Log4Shell while missing thousands of
   advisories. About a second.
6. **Install** — the staging folder is renamed into place and `current.json` replaced (both
   atomic); new requests get the new build at once.

Anything that fails leaves the current build serving: the staging folder is removed, the error is
logged and shown as `last_error` on `/health`, and the next try comes after 5 min, then 10, 20, …
up to the check interval.

```
VULN_DATA_DIR/
  trivy/<built-at>/db/{trivy.db,metadata.json}  + build.json
  grype/<built-at>/6/vulnerability.db           + build.json
  staging/<tool>-<random>/                       downloads land here
  current.json                                   {"trivy": "<folder>", "grype": "<folder>"}
```

- **Switching.** A request leases one Trivy and one Grype build when it gets its scan slot and lets
  go when its scan ends. Each scanner is handed its build's folder, so a scan that started on the
  old build keeps reading it. Nothing in a live build folder is ever written again.
- **Old builds** are deleted as soon as no request holds them — not kept as a "previous" build: a
  rollback would need a person, and nothing is installed without passing the smoke test.
- **Disk:** ~4.4 GB steady (Trivy 1.5 GB, Grype 2.9 GB); up to ~9 GB while both tools download
  at once. Downloads are ~126 MB and ~250 MB; Trivy's takes ~5 s, Grype's ~1 min, mostly
  decompressing.
- **Cadence:** Trivy publishes every ~6 h, Grype about daily. They switch independently: holding a
  Trivy build back for Grype's would only make it staler.
- **Boot:** `staging/` is emptied, `current.json` is read, each build it names is checked (its
  files and `build.json`), and build folders it does not name are deleted (crash leftovers). A tool
  with a build serves at once — a restart answers its first request in about a second, with no
  download. A tool with none starts downloading right away, and until both have a build
  `/vulnerabilities` answers 503 `databases not ready` with `"reason": "<tool>: downloading"`
  (about 75 s from empty on a good line). A `current.json` that does not parse means starting over.
- **Shutdown** stops the loops and kills a download in flight.

| variable | default | meaning |
|---|---|---|
| `VULN_DATA_DIR` | — | turns managed mode on; the server must be able to write here |
| `VULN_DB_CHECK_INTERVAL_MIN` | `30` | how often each tool checks for a new build, 5..1440. 30 min adds ~15 min of average staleness to Trivy's 6 h, for ~100 tiny requests a day |
| `VULN_DB_DOWNLOAD_TIMEOUT_MS` | `900000` | one download before it is killed, 60000..7200000 |
| `TRIVY_DB_REPOSITORY` | `mirror.gcr.io/aquasec/trivy-db:2` | checked and downloaded from (Trivy's own default; anonymous ghcr pulls are rate-limited). `:2` is added when there is no tag |
| `GRYPE_DB_UPDATE_URL` | `https://grype.anchore.io/databases/v6/latest.json` | checked, and handed to `grype db update` |

**Seeding for testing.** To start from builds you already have instead of downloading, clone them
in (on APFS `cp -c` costs no disk) and write the two small files by hand:

```bash
D=/var/lib/vuln
mkdir -p $D/trivy/2026-10-01T100405Z $D/grype/2026-10-01T063348Z
cp -c -R /old/trivy/db $D/trivy/2026-10-01T100405Z/
cp -c -R /old/grype/6  $D/grype/2026-10-01T063348Z/
echo '{"tool":"trivy","built_at":"2026-10-01T10:04:05.794145908Z","schema":"2","upstream_id":null,"canary_findings":null,"installed_at":"2026-10-01T20:00:00Z"}' > $D/trivy/2026-10-01T100405Z/build.json
echo '{"tool":"grype","built_at":"2026-10-01T06:33:48Z","schema":"v6.1.9","upstream_id":null,"canary_findings":null,"installed_at":"2026-10-01T20:00:00Z"}' > $D/grype/2026-10-01T063348Z/build.json
echo '{"trivy":"2026-10-01T100405Z","grype":"2026-10-01T063348Z"}' > $D/current.json
```

`built_at` must be what the database reports (`db/metadata.json`'s `UpdatedAt`, `grype db status`'s
`built`). With no `upstream_id` the first check downloads Trivy's newest build and switches to it
if it is newer; Grype is compared by `built` and only downloaded if the publisher has a newer one.
`canary_findings: null` skips the 90 % rule for that first switch; the measured count is stored
from then on.
