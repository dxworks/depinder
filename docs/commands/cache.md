# cache & update

Two backends. **SQLite**, the default: `~/.dxw/depinder/cache/depinder.sqlite`, shared by every
run on the machine, nothing to install. **MongoDB**, optional: used automatically when its
container is running.

## cache

```
depinder cache                 same as `cache info`
depinder cache info            SQLite path and row counts; is depinder-mongo running?
depinder cache import <dir>    pull a libs.json / misses.json folder into SQLite
depinder cache init            write the MongoDB docker-compose files to ~/.dxw/depinder/cache/
depinder cache up              start MongoDB   (alias: start)
depinder cache down            stop MongoDB    (alias: stop)
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

### MongoDB

`init` writes the Compose file once. It starts `depinder-mongo` on port `27018` (user `root`,
password `secret`) and Mongo Express on [localhost:8002](http://localhost:8002/).

!!! warning
    The Compose file joins an external Docker network, `traefiknet`. Create it once with
    `docker network create traefiknet`, or edit the file.

Connection: `MONGO_URI`, `MONGO_USER`, `MONGO_PASSWORD` — see [Configuration](../configuration.md).

## update

```
depinder update [updated_before] [plugins...]
```

Refreshes MongoDB entries older than `updated_before` (default one month ago) for the plugins
named (default all). Needs the container running and `GH_TOKEN`. SQLite has no equivalent: use
`--refresh`.
