# Fixture cases

One recorded registry answer per package: `<case-id>/case.json` (purl, ecosystem, the pattern the
case protects, `found` or `not_found`, and every response core's `fetchPackage` received, in order)
plus the bodies exactly as received.

Record or re-record a case (live, with core's real `fetchPackage`):

```bash
npm run record-fixture-case -w @depinder/core -- <case-id> <purl> "<pattern>"
```

Check the pattern is still present in the new recording before committing: registries change.

Replay a case offline with `replayFetch(loadFixtureCase(dir))` from `@depinder/core/testing`; it
answers only the recorded URLs and rejects anything else. `test/fixture-cases.test.ts` replays
every case through `fetchPackage`.

The parity test (`packages/parity`) takes every case down both roads, the server's and the CLI
fallback's, and needs nothing else: a new case is covered the moment it is committed. Every
registry bug gets one.
