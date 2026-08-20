<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/python

**Role:** Python (pip/pipenv/poetry) dependency source — generates/parses pipenv dependency
trees and lock files into a DepinderProject and enriches libraries from PyPI/Libraries.io.

## Files
- `index.ts`
  - `DepTreeEntry` (interface) — pipenv graph entry: a package plus its direct dependencies :199
  - `pythonRegistrar` (const: Registrar) — PyPiRegistrar chained to LibrariesIORegistrar('pypi') :231
  - `python` (const: Plugin) — plugin descriptor: extractor, parser, registrar, checker;
    aliases `pip`/`pipenv`/`poetry` :233
  - +7 internal helpers not listed

## Notes
- Only the Pipfile/Pipfile.lock path builds a real dependency graph; pyproject.toml, setup.py and
  requirements.txt manifests parse to a project with zero dependencies.
- Requires the `pipenv` CLI on PATH at extraction time (invoked via `execSync` for `lock`,
  `install`, and `graph --json`); failures are logged and swallowed, not thrown.
