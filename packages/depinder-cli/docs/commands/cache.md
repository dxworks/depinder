# cache & update

One backend: **SQLite**, `~/.dxw/depinder/cache/depinder.sqlite`, shared by every run on the
machine, nothing to install. Each machine has its own.

## cache

```
depinder cache                 same as `cache info`
depinder cache info            SQLite path, size, row counts, fresh/expired split   (alias: i)
depinder cache import <dir>    pull a libs.json / misses.json folder into SQLite
```

### SQLite

| Table | Holds |
|---|---|
| `libs` | Registry answer per `<ecosystem>:<name>`: versions with dates, licences, homepage, and `updated_at`, when its facts were last confirmed against the registry |
| `misses` | Failed lookups, forgotten after 24 hours; HTTP 429 is never recorded |

`DEPINDER_CACHE_DB=<file>` points a run at another database. `--refresh` bypasses `libs` and
`misses` for one run.

### Expiry

A `libs` row confirmed more than the **cache max age** ago is expired: `analyse` treats it as
missing, asks the bulk resolver and then the registry for it, and rewrites it with a new age. If
nothing answers, the dependency gets no library data, as if it had never been cached. The cutoff is
taken once at the start of a run, so whatever the run fetches from a registry stays fresh for the
rest of it.

A row's age is when its facts were last confirmed, not when depinder wrote it. A registry fetch is
confirmed the moment it lands; a bulk resolver answer carries the server's own confirmation time.
An answer the resolver could not reconfirm within the max age (`refreshing`) is still used by the run
that received it, but is written already expired, so the next run asks for it again.

| Setting | Meaning | Default |
|---|---|---|
| `--cache-max-age <duration>` | `<n>[s\|m\|h\|d]`, a bare number being seconds; `0` expires everything on disk | `DEPINDER_CACHE_MAX_AGE`, else `1d` |

`analyse`, `update` and `cache info` all take it. The 24-hour miss TTL is a separate setting: it says
how soon a *failed* lookup is retried, not how long an answer may be reused.

!!! note "Coming from `cache/libs.json`"
    `depinder cache import cache` copies the old per-directory files into the database. Existing
    rows are kept; the files are not touched. Imported libraries are as old as `libs.json` (its
    modification time), so a file older than the max age imports as expired.

## update

```
depinder update [updated_before] [plugins...]
```

Re-fetches the `libs` rows last written before `updated_before` (default: the expired ones, older
than `--cache-max-age`) for the plugins named (default all), by name or
[alias](../index.md#ecosystems): `sbom-java` and `java` both refresh the `java:` entries. With `GH_TOKEN` set, GitHub advisories are fetched too; a failed advisory lookup still keeps the registry data. To bypass the cache for a
single run instead, use `analyse --refresh`.

Each row is fetched the way `analyse` fetches a package the resolver did not answer: from its
registry through the [registry fallback](../configuration.md#registry-fallback), Libraries.io
included, with the same per-ecosystem limits.

| Option | Meaning | Default |
|---|---|---|
| `--cache-max-age <duration>` | Without a date, re-fetch the rows older than this; see [expiry](#expiry) | `DEPINDER_CACHE_MAX_AGE`, else `1d` |
| `--registry-limits <limits>` | Registry requests at once per ecosystem, with an optional gap in ms: `npm=16,cargo=1:1000` | `DEPINDER_REGISTRY_LIMITS`, else 8 at once (`golang` 64, `nuget` 32) |

To pick plugins, give a date first:

```bash
depinder update 2026-10-01 java --registry-limits maven=4:250
```
