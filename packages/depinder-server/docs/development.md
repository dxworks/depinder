# Development

For contributors: running the server locally, the tests (including the Postgres integration test),
the typecheck and the build.

The server is the Nx project `depinder-server`. From the monorepo root (after `npm ci` there):

```bash
npx nx test depinder-server              # vitest; no network, no database
npx nx typecheck depinder-server
npx nx lint depinder-server              # function sizes
npx nx build depinder-server             # -> packages/depinder-server/dist/
npx nx test-integration depinder-server  # the tests plus the Postgres ones, on depinder-pg (below)
npx nx docker-build depinder-server      # the image, from the monorepo root
npm run dev -w depinder-server           # tsx watch
```

Inside `packages/depinder-server`, `npm test`, `npm run typecheck`, `npm run build` and `npm run dev`
work too.

Tests never hit the network: feed tests stub `fetch` with recorded fixtures (the fetchers' own
tests and recorded answers are in `packages/depinder-core`), and the API tests use a stubbed store.
Keep it that way.

`test/resolver/db/db.integration.test.ts` runs the real SQL — migrations, the queue, the feed
cursors, the migration backfill — and is skipped unless you point it at a throwaway database:

```bash
docker run -d --rm --name depinder-pg -e POSTGRES_PASSWORD=depinder -e POSTGRES_DB=depinder \
  -p 55432:5432 postgres:16-alpine
npx nx test-integration depinder-server
# the same as: TEST_DATABASE_URL=postgresql://postgres:depinder@127.0.0.1:55432/depinder npm test
```
