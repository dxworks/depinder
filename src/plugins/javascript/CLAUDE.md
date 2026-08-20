<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/javascript

**Role:** JavaScript/npm dependency source — extracts package.json/lockfile
contexts, parses them into a DepinderProject, and enriches libraries from the
npm registry.

## Files
- `index.ts`
  - `retrieveFromNpm` (function) — library metadata (versions, license,
    description) from the npm registry API :230
  - `javascript` (const: Plugin) — plugin descriptor: extractor globs, lockfile
    parser, npm registrar, GitHub advisory checker :260

## Notes
- Parses npm v1/v2/v3 and yarn v1/v2 lockfiles; pnpm lockfiles (v5/v6/v9) are
  detected but rejected with a thrown error, unsupported by Depinder.
- When a `package.json` has no lockfile in its own or an ancestor dir, the
  extractor silently shells out to `npm install --package-lock-only` to
  generate one before parsing.
