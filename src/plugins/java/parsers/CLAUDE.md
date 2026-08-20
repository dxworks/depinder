<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/java/parsers

**Role:** Parses `mvn dependency:tree` text output into a DepinderProject dependency graph.

## Files
- `maven.ts`
  - `parseMavenDependencyTree` (function) — turns Maven's ASCII dependency-tree
    output into a DepinderProject, resolving parent/child edges via indentation
    depth :5
  - +1 internal helpers not listed

## Notes
- Depth is inferred purely from `|  `/`   ` indentation prefixes, not explicit
  markers; a line's parent is whatever is still on the stack with a lower level.
