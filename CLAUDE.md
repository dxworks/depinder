<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# depinder (repo root)

**Role:** CLI that resolves a repository's dependency tree per ecosystem, enriches it from package
registries, matches vulnerabilities, and writes CSV reports.

## Navigating this repo
Every code-bearing directory has its own `CLAUDE.md` indexing what lives there. Read the one in the
directory you are working in — not the whole tree. Detail decays with distance: a file lists its own
symbols in full, its direct subdirectories by class name only, and nothing deeper. Descend one level
at a time. The format is specified in `AI_INDEX_FORMAT.md`; regenerate bottom-up.

## Files
- `package.json` — bin `depinder` → `dist/index.js`. Scripts: `build`, `test` (jest), `lint`,
  `local` (build + npm link + `--help`)
- `jest.config.js` — ts-jest config for `__tests__`
- `tsconfig.json` / `tsconfig.build.json` — dev vs. emit config; build copies `src/assets`
- `mkdocs.yml` — docs site config for `docs/`

## Subdirs
- `src/` — all product code: CLI entry, commands, plugin contracts, ecosystem plugins, cache,
  utils. `mainCommand`, `Plugin`, `DepinderProject`, `Extractor`, `Parser`, `Registrar`, `Cache`
- `__tests__/` — jest suite: analyse CLI options, plugin wiring, tree parsers, SBOM ingestion and
  local scan, registry access
- `docs/` — MkDocs sources published as the user-facing site
- `releaseNotes/` — one file per released version; a release tag requires its notes to be merged first
- `.github/workflows/` — CI and release automation

## Notes
- Entry path is `src/index.ts` → `src/depinder.ts` (`mainCommand`) → `src/commands/*`. Nothing
  self-registers; a new subcommand must be added to `mainCommand` explicitly.
- Two independent dependency-source families live under `src/plugins/`: the native manifest
  parsers (java, javascript, python, php, ruby, dotnet), which need ecosystem tooling to have run
  first, and `sbom/`, which reads Syft/Trivy CycloneDX output and needs no build.
- `dist/`, `node_modules/`, `results*/` and `cache/` are generated — never index or edit them.
