# Black Duck Export

[`export-blackduck`](commands/export-blackduck.md) writes the four CSVs a Black Duck project
version exports, with Black Duck's exact headers, plus files Black Duck has no counterpart for.

## Files

| File | One row per | Notes |
|---|---|---|
| `_dependencies.csv` | (component, version, origin) | First header is `1Component name`, Black Duck's own spelling |
| `_dependencies_sources.csv` | (component, path) | One chain per component, from the SBOM's `dependsOn` edges |
| `_upgrade_guidance.csv` | component with a finding | Short and long term recommended versions |
| `security.csv` | (component, advisory) | Black Duck's `security_*.csv` header; triage and CISA columns empty |
| `_dependency_edges.csv` | (parent, child) | **Ours.** Every edge: `Repo, Tree, Ecosystem, Parent Origin Id, Child Origin Id, Child Depth` |
| `_vulnerability_findings.json` | component with a finding | **Ours.** The findings as the exporter saw them, fix versions included |

A column not derivable from an SBOM plus a public registry is **empty**, never guessed.

## `_dependencies.csv` and `_dependencies_sources.csv`

| Column | Source | Derivation |
|---|---|---|
| `Component name` | purl | Registry name. Black Duck's is a KB display name; join on the origin id |
| `Component version name` | purl | verbatim |
| `Component Version Origin Id` | purl | `name/version` (npmjs, rubygems, pypi, nuget, crates), `name:version` (maven, packagist). Go: `owner/repo:version` |
| `Origin name` | purl type | `npm`→`npmjs`, `gem`→`rubygems`, `composer`→`packagist`, `cargo`→`crates`; Go by host (`github`, `long_tail`, `unknown`) |
| `License names` | registrar, else SBOM | SPDX id → Black Duck display name; unmapped ids written as-is |
| `License families` | same table | `PERMISSIVE` / `WEAK_RECIPROCAL` / `RECIPROCAL` / `RESTRICTED_PROPRIETARY` / `UNKNOWN` |
| `License Risk` | families | `OK` / `MEDIUM` / `HIGH` / `UNKNOWN` — see [risk](#risk-columns) |
| `Match type` | `requestedBy` | `Direct Dependency`, `Transitive Dependency`, or both |
| `Usage` | — | `DYNAMICALLY_LINKED` |
| `Operational Risk` | date + newer versions | `OK` / `LOW` / `MEDIUM` / `HIGH` — see [risk](#risk-columns) |
| Vulnerability counts | findings | Counted; `0` written where Black Duck leaves blank |
| `Release Date` | registrar | ISO date |
| `Newer Versions` | registrar | Versions **published after** the installed one, Black Duck's rule |
| `Newer Versions (semver)` | registrar | **Ours.** Count by version number |
| `Component Link` | registrar | Declared project homepage, per component. Empty when none, as Black Duck. Go: derived from the module path |
| `Path` | `dependsOn` | `<project>/-<pm>/<name>/<version>/…` — see [paths](#paths) |
| `ProjectPath` | — | Project name, plus `/<module>` when named |
| Open Hub columns, `Has License Conflicts`, `ProjectPathExists`, `VerifiedPath` | — | empty or constant |

## `security.csv`

| Column | Derivation |
|---|---|
| `Vulnerability id` | `GHSA-… (CVE-…)`, Black Duck's `BDSA-… (CVE-…)` shape |
| `Vulnerability source` | `GHSA`, `TRIVY`, `GRYPE`; a finding two sources agree on reports `GHSA` |
| `Published on` | Black Duck's `7/24/26` date shape |
| `Base score` | GHSA's score first, then NVD. Black Duck's is NVD CVSS 3.x |
| `Exploitability`, `Impact` | CVSS 3.1 sub-scores; empty for v4 and v2 |
| `URL` | NVD page when a CVE is known, else the scanner's |
| `CWE Ids` | `[CWE-400, CWE-834]` |
| `Solution available` | `true` when a fixed version is named |
| `CVSS Version` | `CVSS 3.x` / `CVSS 4` / `CVSS 2.x` |
| `Match type` | Two-valued here, as in Black Duck's own file |
| `Remediation status` | `New` |
| `Updated on`, `Overall score`, `Workaround`, `Exploit available`, tags, CISA | empty |

## Paths

`Path` is the shortest chain from the manifest to the component, one row per (component,
project), as Black Duck writes it. Ties go to the greater parent. Segments join name and version
like the origin id. The tag after the project is the package manager whose manifest was walked:
`-yarn`, `-npm`, `-pnpm`, `-rubygems`, `-maven`, `-gradle`, `-packagist`, `-cargo`, `-go_mod`,
`-nuget`, `-uv`, `-pip`. With [`--target`](commands/export-blackduck.md#-target) the project
segment becomes Black Duck's `<name>/<version>/<dir>/` prefix and own code leaves the chain.

**Direct** is what the manifest declares. When an SBOM carries workspace nodes (Syft, yarn berry),
their edges define it; otherwise the lockfile root's do. Syft SBOMs carry chains only where they
carry edges (yarn workspaces, Maven modules); everything else gets a one-hop path.

## Risk columns

Neither is Black Duck's model, which is not published; both are inferred from a reference export.

**License Risk**: `PERMISSIVE` → `OK`; `WEAK_RECIPROCAL`, `RESTRICTED_PROPRIETARY` → `MEDIUM`;
`RECIPROCAL` → `HIGH`. Several licences: `OR` takes the lowest, `AND` the highest. `UNKNOWN`
is ours: Black Duck writes `HIGH` for a licence it cannot read.

**Operational Risk**, decoded on every reference row without Open Hub data:

| Newer versions | Age | Risk |
|---|---|---|
| ≤ 1 | any | `OK` |
| 2 | < 4 years / ≥ 4 | `LOW` / `MEDIUM` |
| ≥ 3 | < 2 / 2–4 / ≥ 4 years | `LOW` / `MEDIUM` / `HIGH` |

Rows with Open Hub data differ: Black Duck knows something we cannot.

## Upgrade guidance

Short term: newest stable version on the installed major that clears every fixable finding, else
the lowest clean version above. Long term: newest stable version overall. Each finding is fixed by
the fix of its own line. Unfixed findings are left out of the choice and counted separately;
a component with only unfixed findings gets an empty recommendation. No network.

## Deliberate differences

| Column | Black Duck | Us |
|---|---|---|
| `Component name` | KB display name | registry name |
| `License Risk` | `HIGH` when unreadable | `UNKNOWN` |
| `Base score` | NVD CVSS 3.x | GHSA first |
| `Component Link` | oldest version's homepage | current registry homepage |
| `Newer Versions` | KB list | registry list |
| Vulnerability counts | blank for 0 | `0` |
