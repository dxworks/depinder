<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/cache

**Role:** Pluggable key-value cache for `LibraryInfo` lookups, with no-op, JSON-file and MongoDB
backends behind a common interface.

## Files
- `cache.ts`
  - `Cache` (interface) — contract for a LibraryInfo store. `get`, `set`, `has`, `load`, `write` :3
  - `noCache` (const: Cache) — disables caching; every lookup misses :11
- `json-cache.ts`
  - `jsonCache` (const: Cache) — persists LibraryInfo to `cache/libs.json` on disk, lazy-loaded
    into an in-memory Map. `load`, `get`, `set`, `has`, `write` :19
- `mongo-cache.ts`
  - `LibraryInfoModel` (const: Model<LibraryInfo>) — Mongoose model backing the Mongo cache :45
  - `mongoCache` (const: Cache) — persists LibraryInfo in MongoDB, connecting/disconnecting on
    `load`/`write`. `get`, `set`, `has`, `load`, `write` :52

## Notes
- `jsonCache` resolves its file relative to `process.cwd()/cache`, not this module's location.
- `mongoCache` defaults to `mongodb://localhost:27018/depinder` with root/secret credentials
  unless `MONGO_URI`/`MONGO_USER`/`MONGO_PASSWORD` env vars are set.
