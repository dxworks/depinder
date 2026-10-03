# Development

For contributors: running the server locally, the tests (including the Postgres integration test),
the typecheck and the build.

```bash
npm run dev         # tsx watch
npm test            # vitest; no network, no database
npm run typecheck
npm run build       # -> dist/
```

Tests never hit the network: registry tests stub `fetch` with recorded fixtures, and the API tests
use a stubbed store. Keep it that way.

`test/resolver/db/db.integration.test.ts` runs the real SQL — migrations, the queue, the feed
cursors, the migration backfill — and is skipped unless you point it at a throwaway database:

```bash
docker run -d --rm --name depinder-pg -e POSTGRES_PASSWORD=depinder -e POSTGRES_DB=depinder \
  -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgresql://postgres:depinder@127.0.0.1:55432/depinder npm test
```
