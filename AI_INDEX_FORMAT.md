# AI Index Format (`CLAUDE.md` per directory)

Every code-bearing directory carries a `CLAUDE.md` that indexes **what lives there**, so an agent
can start at the repo root and descend straight to the file it needs without grepping the tree.

These files are a **map, not a tutorial**. Rules, conventions and how-to guidance belong in the root
`CLAUDE.md` only.

## The decay rule

Detail decays with distance. This is the whole design — it keeps every file small and keeps a
symbol described in exactly one place.

| Distance | What the file lists |
| --- | --- |
| Own files (level 0) | Every exported class / interface / type / function, its key methods, and `:line` |
| Direct subdirectories (level 1) | One-line purpose, plus **top-level exported names only** — classes, types and functions. No methods, no properties. Cap at 10 names, then `+N more` |
| Level 2 and deeper | Nothing. That directory's own `CLAUDE.md` covers it |

Rationale: an agent at the root only needs enough to **pick a branch**. One more hop costs one
~40-line read, while repeating grandchildren duplicates content, rots on every rename, and floods
the working context with symbols the agent will never open.

## Hard constraints

- **60 lines maximum**, whole file. If a directory cannot fit, list only the exported surface and
  say `+N internal helpers not listed`.
- **Only `export`ed symbols are listed.** A top-level `const`, `class` or `function` without the
  `export` keyword is internal: it is NOT indexed by name, it is counted in a trailing
  `+N internal helpers not listed`. Verify with `grep -nE '^export' <file>` — do not index a
  symbol because it sits at the top level of the file.
- **One line per symbol.** No code blocks, no prose paragraphs, no bullet lists nested more than
  two deep.
- Symbol line shape: `` `Name` (kind) — one-line purpose. `method`, `method` :line ``
  - *kind* is one of: class, interface, type, enum, const, function.
  - `→ Base` after a class name records what it extends or implements.
  - `:line` is the declaration line in that file. Approximate is fine; omit if unstable.
- Purposes are **what it is for**, never what it is called. `parses deptree.txt into a
  DepinderProject` — not `parser for maven`.
- `## Notes` is optional, capped at 3 bullets, and reserved for things an agent would get *wrong*
  by reading the code alone (required inputs, silent failure modes, canonical-implementation
  pointers).
- No status, no history, no TODOs. Those live in `dxworks/TODO.md`.

## Section order (fixed)

```markdown
<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# <path from repo root>

**Role:** one sentence — what this directory is responsible for.

## Files
- `file.ts`
  - `Symbol` (kind) — purpose. `keyMethod`, `otherMethod` :99

## Subdirs
- `child/` — one-line purpose. `ClassA`, `ClassB`

## Notes
- At most three, only for non-inferable facts.
```

Omit `## Subdirs` in a leaf directory. Omit `## Notes` when there is nothing non-obvious.

## Worked example

`src/plugins/java/CLAUDE.md`:

```markdown
<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/java

**Role:** Java/Maven dependency source — parses a Maven dependency tree into a
DepinderProject and enriches libraries from Maven Central.

## Files
- `index.ts`
  - `MavenCentralRegistrar` (class → AbstractRegistrar) — library metadata from
    search.maven.org, falling back to fetching and parsing the POM.
    `retrieveFromRegistry`, `getPom` :99
  - `java` (const: Plugin) — plugin descriptor: extractor globs, parser, registrar :159
  - +3 internal helpers not listed
- `google.registrar.ts`
  - no exported symbols — the whole file is commented-out draft code

## Subdirs
- `parsers/` — manifest text into a DepinderProject. `parseMavenDependencyTree`

## Notes
- Requires a `deptree.txt` produced by `mvn dependency:tree`; without one this plugin
  parses zero modules. The SBOM plugins have no such prerequisite.
```

## Maintenance

Regenerate a directory's file bottom-up: a directory is only rewritten after all of its children
are current, since its `## Subdirs` section is built by reading the children's `CLAUDE.md`, never
by reading their source.
