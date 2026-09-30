# cache & update

One backend: **SQLite**, `~/.dxw/depinder/cache/depinder.sqlite`, shared by every run on the
machine, nothing to install. Each machine has its own.

## cache

```
depinder cache                 same as `cache info`
depinder cache info            SQLite path, size and row counts   (alias: i)
depinder cache import <dir>    pull a libs.json / misses.json folder into SQLite
```

### SQLite

| Table | Holds |
|---|---|
| `libs` | Registry answer per `<ecosystem>:<name>`: versions with dates, licences, homepage |
| `misses` | Failed lookups, forgotten after 24 hours; HTTP 429 is never recorded |

`DEPINDER_CACHE_DB=<file>` points a run at another database. `--refresh` bypasses `libs` and
`misses` for one run.

!!! note "Coming from `cache/libs.json`"
    `depinder cache import cache` copies the old per-directory files into the database. Existing
    rows are kept; the files are not touched.

!!! note "Coming from the MongoDB cache"
    The MongoDB cache and `cache init` / `up` / `down` are gone. `docker-compose.yml` and
    `init-mongo.js`, left in `~/.dxw/depinder/cache/` by an earlier `cache init`, are no longer
    used and can be deleted.

## update

```
depinder update [updated_before] [plugins...]
```

Re-fetches the `libs` rows last written before `updated_before` (default one month ago) for the
plugins named (default all), by name or [alias](../index.md#ecosystems): `sbom-java` and `java`
both refresh the `java:` entries. Needs `GH_TOKEN` for the advisories. To bypass the cache for a
single run instead, use `analyse --refresh`.
