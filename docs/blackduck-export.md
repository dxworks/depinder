# Black Duck Export

[`export-blackduck`](commands/export-blackduck.md) writes the four shareable CSVs
[`transformBlackDuckReports`](commands/blackduck-reports.md) produces from a real Black Duck
export — same header line, same cell conventions, so a downstream reader processes either folder
the same way — plus the raw-shaped `security.csv` and files Black Duck has no counterpart for.
The headers and cell rules live in one module, `src/blackduck/columns.ts`, that both commands
import.

## Files

| File | One row per | Notes |
|---|---|---|
| `_dependencies.csv` | (component, version, origin) | The transform's 25 columns |
| `_dependencies_sources.csv` | (component, path) | The transform's 23 columns; one chain per component, from the SBOM's `dependsOn` edges |
| `_vulnerability_details.csv` | (component, advisory) | The transform's 23 columns: `security.csv` without Black Duck's ids, triage and CISA block |
| `_upgrade_guidance.csv` | component with a finding | Short and long term recommended versions |
| `security.csv` | (component, advisory) | Black Duck's raw `security_*.csv` header; triage and CISA columns empty |
| `_dependency_edges.csv` | (parent, child) | **Ours.** Every edge: `Repo, Tree, Ecosystem, Parent Origin Id, Child Origin Id, Child Depth` |
| `_component_versions.csv` | component | **Ours.** `Release Date` (plain ISO), `Newer Versions`, `Newer Versions (semver)` |
| `_vulnerability_findings.json` | component with a finding | **Ours.** The findings as the exporter saw them, fix versions included |

A column not derivable from an SBOM plus a public registry is **empty**, never guessed.

## Cell conventions

The four shareable files follow the transform's rules, so a cell reads the same whichever
command wrote it:

| Rule | Where |
|---|---|
| `Match type` is `Direct`, `Transitive` or `Direct,Transitive` | `_dependencies.csv`, `_dependencies_sources.csv`. `_vulnerability_details.csv` and `security.csv` keep `Direct Dependency` / `Transitive Dependency`, as the transform does |
| A zero per-severity vulnerability count is blank; `Total` and `Critical and High` are always a number, the sum of the four | both dependency files |
| Dates are `\tYYYY-MM-DD` — the leading tab keeps Excel from re-reading them | `Release Date`, `Published on`, `Updated on`. `security.csv` keeps Black Duck's raw `7/24/26` |
| `Version id` is empty | Black Duck's internal version UUID; nothing on our side corresponds to it |
| `VerifiedPath` empty, `VerifiedPathMethod` = `not-checked` | What the transform writes when no `--basePath` verifies paths on disk; we verify none |
| Every file ends with a newline | all |

## `_dependencies.csv` and `_dependencies_sources.csv`

| Column | Source | Derivation |
|---|---|---|
| `Component name` | purl | Registry name. Black Duck's is a KB display name; join on the origin id |
| `Component version name` | purl | verbatim |
| `Version id` | — | empty |
| `Component Version Origin Id` | purl | `name/version` (npmjs, rubygems, pypi, nuget, crates), `name:version` (maven, packagist). Go: `owner/repo:version` |
| `Origin name` | purl type | `npm`→`npmjs`, `gem`→`rubygems`, `composer`→`packagist`, `cargo`→`crates`; Go by host (`github`, `long_tail`, `unknown`) |
| `License names` | registrar, else SBOM | SPDX id → Black Duck display name; unmapped ids written as-is |
| `License families` | same table | `PERMISSIVE` / `WEAK_RECIPROCAL` / `RECIPROCAL` / `RESTRICTED_PROPRIETARY` / `UNKNOWN` |
| `License Risk` | families | `OK` / `MEDIUM` / `HIGH` / `UNKNOWN` — see [risk](#risk-columns) |
| `Match type` | `requestedBy` | `Direct`, `Transitive`, or `Direct,Transitive` |
| `Usage` | — | `DYNAMICALLY_LINKED` |
| `Operational Risk` | date + newer versions | `OK` / `LOW` / `MEDIUM` / `HIGH` — see [risk](#risk-columns) |
| Vulnerability counts | findings | Per severity, blank when zero; `Total` and `Critical and High` are the sums |
| `Release Date` | registrar | `\tYYYY-MM-DD` |
| `Newer Versions` | registrar | Versions **published after** the installed one, Black Duck's rule. The count by version number is in `_component_versions.csv` |
| `Component Link` | registrar | Declared project homepage, per component. Empty when none, as Black Duck. Go: derived from the module path |
| `Path` | `dependsOn` | `<project>/-<pm>/<name>/<version>/…` — see [paths](#paths) |
| `ProjectPath` | — | Project name, plus `/<module>` when named |
| `VerifiedPath`, `VerifiedPathMethod` | — | empty, `not-checked` |
| Open Hub columns, `Has License Conflicts` | — | empty or constant |

## `security.csv` and `_vulnerability_details.csv`

`security.csv` is Black Duck's raw `security_*.csv` shape. `_vulnerability_details.csv` is the
23-column view the transform makes of it: `Component origin id` becomes
`Component Version Origin Id`, `Published on` and `Updated on` become `\tYYYY-MM-DD`, and the
id, triage and CISA columns are dropped. The derivations are the same:

| Column | Derivation |
|---|---|
| `Vulnerability id` | `GHSA-… (CVE-…)`, Black Duck's `BDSA-… (CVE-…)` shape |
| `Vulnerability source` | `GHSA`, `TRIVY`, `GRYPE`; a finding two sources agree on reports `GHSA` |
| `Published on` | Black Duck's `7/24/26` date shape in `security.csv`; `\tYYYY-MM-DD` in `_vulnerability_details.csv` |
| `Base score` | GHSA's score first, then NVD. Black Duck's is NVD CVSS 3.x |
| `Exploitability`, `Impact` | CVSS 3.1 sub-scores; empty for v4 and v2 |
| `URL` | NVD page when a CVE is known, else the scanner's |
| `CWE Ids` | `[CWE-400, CWE-834]` |
| `Solution available` | `true` when a fixed version is named |
| `CVSS Version` | `CVSS 3.x` / `CVSS 4` / `CVSS 2.x` |
| `Match type` | Two-valued here, `Direct Dependency` / `Transitive Dependency`, in both files |
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
| `Version id` | version UUID | empty |
