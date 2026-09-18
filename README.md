# Dxworks depinder

This project was generated using the `dxworks-template-node-ts` repository template.

## Installation

Use `npm` to install

```shell
npm i -g @dxworks/depinder
```

or, to use it from `dxw cli`:

```shell
dxw plugin i @dxworks/depinder
```

To check if the installation was successful, run:

```shell
depinder --version
```

## Configuration
`Depinder` relies on `GitHub` and `Libraries.io` to get information about packages and known security vulnerabilities. In order to call these downstream services, you need to add two environment variables with the corresponding tokens:
- `GH_TOKEN` should contain a `GitHub` token with the `read:packages` scope.
- `LIBRARIES_IO_API_KEY` should contain the `Libraries.io` API Key.

### GitHub advisories as a vulnerability source

The SBOM analysis can match components against a local copy of GitHub's reviewed security
advisories, alongside (or instead of) Trivy and Grype:

```shell
# Fill the cache for just the ecosystems a set of SBOMs contains
depinder github-advisories download --sbom ./sboms
depinder github-advisories status

# Analyse with the GitHub source
depinder analyse ./sboms -r out -p sbom-npm --vuln-source github
```

`--vuln-source` takes a comma-separated list of `trivy`, `grype`, `github` and `all`, and defaults
to `trivy,grype` — today's behaviour. Whichever sources run, the findings also go to
`security.csv` next to the libs CSVs, one row per (component, advisory), in Black Duck's own
column shape (see [Black Duck-shaped exports](#black-duck-shaped-exports)).

The download needs GitHub tokens. Put them in a dotenv-style file — `.github-tokens` in the working
directory by default, `--github-token-file` to point elsewhere:

```
GH_TOKEN_1=ghp_...
GH_TOKEN_2=ghp_...
```

Numbering must be contiguous from 1; a bare `GH_TOKEN` is accepted as a pool of one, and the same
variables are read from the environment when no file exists. Tokens are used in rotation, one
in-flight request each (so the pool size is the concurrency, capped at 4), and each is stood down
before its rate-limit window is exhausted rather than after. The cache lives in
`cache/github-advisories/`, one JSON file per ecosystem, and is re-downloaded when older than
`--github-max-age` hours (default 24).

## Black Duck-shaped exports

`export-blackduck` turns a folder of CycloneDX SBOMs into the four CSVs a Black Duck project
version exports, with Black Duck's exact column headers, so the two can be diffed side by side,
plus one file Black Duck has no counterpart for: `_dependency_edges.csv`, the dependency graph.

```shell
depinder export-blackduck <sbom-folder...> -r <out> \
    [--vuln-source trivy,grype,github] [--github-token-file F] [--project-name NAME]
```

It runs the same analysis `analyse` runs — dependency tree, registry licences and versions,
vulnerabilities from the selected sources — and writes the normal depinder CSVs into the same
folder, then the Black Duck files on top. You do not name plugins: the ecosystems present in
the SBOMs select the `sbom-*` plugins for you.

| File | One row per | Notes |
|---|---|---|
| `_dependencies.csv` | (component, version, origin) | The 25 columns `transformBlackDuckReports` writes, same header line and cell conventions (`src/blackduck/columns.ts`, shared by both commands) |
| `_dependencies_sources.csv` | (component, path) | The transform's 23 columns; the dependency chain, walked from the SBOM's `dependsOn` edges |
| `_vulnerability_details.csv` | (component, advisory) | The transform's 23 columns: `security.csv` without Black Duck's ids, triage and CISA block; dates as `\tYYYY-MM-DD` |
| `_component_versions.csv` | component | **Not a Black Duck file.** `Release Date`, `Newer Versions` and our `Newer Versions (semver)`, the count by version number |
| `_dependency_edges.csv` | (parent, child) | **Not a Black Duck file.** `Path` keeps one chain per component, as Black Duck does, so a component with three parents keeps one; this is every edge, with each component's depth. Columns: `Repo, Tree, Ecosystem, Parent Origin Id, Child Origin Id, Child Depth`. A `Tree` is `<repo>/<module>/-<package manager>`; a component nothing pulls in has parent `(root)` and depth 1 |
| `_upgrade_guidance.csv` | component with ≥ 1 finding | Short/long term recommended versions |
| `security.csv` | (component, advisory) | Black Duck's `security_*.csv` header byte for byte; its internal ids, triage fields and CISA block are empty for us. `analyse` writes this one file too, through the same serialiser |
| `_vulnerability_findings.json` | component with ≥ 1 finding | **Not a Black Duck file.** The findings as the exporter saw them, fix versions per line included — what no CSV carries |

### Column mapping

Where a column is not derivable from an SBOM plus a public registry, it is written **empty** rather
than guessed.

| Black Duck column | Our source | Derivation |
|---|---|---|
| `Component name` | SBOM purl | The registry name. Black Duck's is a Knowledge Base *display* name (`Action Mailer` for `actionmailer`), so the two never match — join on the origin id instead |
| `Component version name` | SBOM purl | verbatim |
| `Version id` | — | **empty** — Black Duck's internal version UUID. `addCategoriesToBlackDuckReports` joins on `Component Version Origin Id` when every `Version id` is empty |
| `Component Version Origin Id` | SBOM purl | `name/version` for npmjs, rubygems, pypi, nuget, crates; `name:version` for maven, packagist — read off the real export, not guessed. Go: `owner/repo:version` under `github`, `go.googlesource.com/<name>#version` under `long_tail`, a pseudo-version written as its 12-character commit (Black Duck holds the full hash) |
| `Origin name` | purl type | `npm`→`npmjs`, `gem`→`rubygems`, `composer`→`packagist`, `cargo`→`crates`, else the purl type; unmapped → `unknown`. Go modules go by host: `github.com/…`→`github`, `golang.org/x/…`→`long_tail`, any other host → `unknown` (Black Duck resolves those to a GitHub repo through its Knowledge Base, which an SBOM does not carry) |
| `License names` | registrar, else the SBOM | SPDX id mapped to Black Duck's display name (`MIT` → `MIT License`); an unmapped id is written as-is so it stays visible. Black Duck collapses `MIT-0` into `MIT License`; we keep the distinct name |
| `License families` | the same table | `PERMISSIVE` / `WEAK_RECIPROCAL` / `RECIPROCAL` / `RESTRICTED_PROPRIETARY` / `UNKNOWN` |
| `Match type` | `requestedBy` | `Direct` / `Transitive` / `Direct,Transitive` — the rule `<plugin>-libs.csv` already uses, made three-valued, in the transform's wording (it strips ` Dependency` from Black Duck's) |
| `Usage` | — | Constant `DYNAMICALLY_LINKED`, which is what Black Duck writes for every row of a dependency scan |
| `Operational Risk` | `Release Date` + `Newer Versions` | `OK` / `LOW` / `MEDIUM` / `HIGH`, **approximated** — see *The two risk columns* below. Empty when either input is missing |
| `License Risk` | `License names` | `OK` / `MEDIUM` / `HIGH` from the licence family, with `OR` read as a choice and `AND` as a conjunction — see below |
| `Critical` / `High` / `Medium` / `Low Vulnerability Count` | findings | Counted from the merged findings; a zero cell is blank, as the transform writes it |
| `Total` / `Critical and High Vulnerability Count` | the four counts | Their sums, always a number. A finding with no recognised severity is in neither, and the exporter warns how many it left out |
| `Release Date` | registrar | `\tYYYY-MM-DD` — the transform's shape, tab included, so Excel keeps the ISO date as text. `_component_versions.csv` carries it plain |
| `Newer Versions` | registrar | Registry versions ordered above the installed one, using the ecosystem's comparator. Empty when no registrar answered. `Newer Versions (semver)`, the count by version number, is in `_component_versions.csv` |
| `Commit Activity`, `Commits in Past 12 Months`, `Contributors in Past 12 Months`, `Open Hub URL` / `OpenHubURL` | — | **empty, not derivable** — Open Hub data |
| `Has License Conflicts` | — | Constant `false`; we run no licence-conflict analysis |
| `Component Link` | registrar homepage, else registry | The registrar's `homepageUrl`, falling back to a registry page URL built from the coordinates (maven has none we can derive) |
| `Path` | SBOM `dependsOn` | `<project>/-<package manager>/<name>/<version>/…` — see *Dependency paths* below |
| `ProjectPath` | — | The project name, plus `/<module>` when the SBOM names its modules |
| `VerifiedPath`, `VerifiedPathMethod` | — | empty and `not-checked` — what the transform writes without `--basePath` |
| `Vulnerability id` | findings | `GHSA-… (CVE-…)` when both are known, else the single id — Black Duck's `BDSA-… (CVE-…)` shape. We have no BDSA numbers |
| `Vulnerability source` | finding origin | `GHSA` (advisory cache), `TRIVY`, `GRYPE`. A finding two sources agree on reports the advisory database, since that is the one that names it |
| `Description`, `Security Risk` | findings | verbatim from the source |
| `Published on` | findings | `7/24/26` in `security.csv`, Black Duck's raw shape (unpadded, two-digit year, UTC); `\tYYYY-MM-DD` in `_vulnerability_details.csv`, as the transform rewrites it |
| `Base score` | findings | GHSA's score first — the catalogue our ids are named after, CVSS 4 nowadays — then NVD's (on grype it sits on the related CVE record, not the GHSA one), then the highest of any other source. Black Duck's column is NVD's CVSS 3.x, so the two differ wherever GHSA rescored; that is a chosen difference, not a normalisation gap |
| `Exploitability`, `Impact` | CVSS 3.x vector | The CVSS 3.1 sub-scores (specification §7.1), rounded to one decimal as Black Duck prints them. Empty for a CVSS 4 or 2 vector, which have no such split |
| `URL` | findings | The NVD page, `https://nvd.nist.gov/vuln/detail/<CVE>`, whenever a CVE is known — Black Duck links there whatever the catalogue. Without a CVE, the scanner's own page |
| `Updated on`, `Overall score` | — | **empty, not derivable** — Black Duck's own scoring and re-publication dates |
| `CWE Ids` | findings | Black Duck's list syntax, `[CWE-400, CWE-834]` |
| `Solution available` | findings | `true` when the source named a fixed version |
| `Workaround available` | — | **empty, not derivable** |
| `Exploit available` | — | **empty** — CISA KEV is not wired up, so this is unknown rather than `false` |
| `CVSS Version` | CVSS vector prefix | `CVSS 3.x` / `CVSS 4` (Black Duck's spellings) / `CVSS 2.x` for a prefix-less v2 vector |
| `Match type` (vulnerability files) | `requestedBy` | `Direct Dependency` / `Transitive Dependency` — the same words, but two-valued: Black Duck's own `security_*.csv` never writes the combined value, so a component reached both ways is reported here as direct |
| `Remediation status` | — | Constant `New`; we hold no triage state |
| `Vulnerability tags`, `Reachable`, `Status justification`, remediation dates, all `CISA *` | — | **empty, not derivable** |
| `Short/Long Term Recommended *` | registry versions + fixed versions | See *Upgrade guidance* below |

### Dependency paths

`Path` is walked from the SBOM's own `dependencies[].dependsOn` edges, from the same project nodes
the parser builds projects from, so `Direct` in `_dependencies.csv` and a one-segment path here are
the same statement. Black Duck writes **one row per (component, project)** — the shortest chain
from the manifest to the component (1,122 rows for ruby-mastodon's 1,239 components) — and so do
we: a package pulled in by two parents appears once, under whichever reaches it soonest, and
where two chains tie on length, under the greater parent (Black Duck reaches `actionpack` through
`rspec-rails`, not `active_model_serializers`; measured on ruby-mastodon, that tie-break matches
636 of 800 chains against 616 in the SBOM's own edge order). A segment joins name and version the
way the origin id does — `org.eclipse.angus:angus-mail:2.0.5`, `laravel/fortify:v1.28.0`,
`lodash/4.17.21` — except that a Go module keeps its full import path (`golang.org/x/sys:v0.47.0`).

The tag after the project is the **package manager whose manifest was walked**, in Black Duck's
spelling: `-yarn`, `-npm` and `-pnpm` for the three JavaScript lockfiles, `-rubygems`, `-maven`,
`-gradle`, `-packagist`, `-cargo`, `-go_mod`, `-nuget`, `-uv`, `-pip`. It is read off the manifest's
basename — Trivy names its `application` node after the manifest, Syft records each component's
`syft:location:0:path` — and falls back to the origin name when neither tool recorded one.

**The two risk columns.** Neither is a port of Black Duck's model, which is not published. Both are
rules inferred from a reference export's own 8,384 rows, and both are checked back against it.

`License Risk` is a function of the licence family — `PERMISSIVE` → `OK`, `WEAK_RECIPROCAL` and
`RESTRICTED_PROPRIETARY` → `MEDIUM`, `RECIPROCAL` and `UNKNOWN` → `HIGH`. What the families column
cannot tell you is what to do with several of them at once, because it flattens the expression and
drops the operator. The operator is the whole answer, and the reference export proves it: `(BSD
2-clause "Simplified" License OR Ruby License)` is `OK` while `(BSD 2-clause "Simplified" License AND
Ruby License)` is `MEDIUM` — the same two licences. `OR` is a choice, so the risk is the lowest
branch; `AND` is a conjunction, so it is the highest. Measured against the reference export: **91.1 %**
of shared rows agree, and **99.3 %** of the rows where we identified the licence at all. The gap is
one thing only — 699 rows we report as `UNKNOWN` and Black Duck does not, which is a licence-coverage
problem showing up in the risk column rather than a fault in the rule.

`Operational Risk` is the one to read with care. Black Duck answers it from two places. When it has
Open Hub telemetry it uses it, and can call a component `HIGH` even on the newest version — 399 of
the 403 rows that are `HIGH` with zero newer versions carry Open Hub data, while 1,577 of the 1,586
that are `OK` carry none. Open Hub is Black Duck's own and we have no equivalent. When it has no
telemetry it falls back to how stale the resolved version is, and that is what we reproduce: newest
version → `OK`, otherwise under two years → `LOW`, under four → `MEDIUM`, past that → `HIGH`. The
result splits exactly along that line — **85.3 %** agreement on components with no Open Hub data,
**46.3 %** on the ones that have it, **75.7 %** overall. A row that differs is a row where Black Duck
knows something we do not, not a row to go and fix.

**What is direct.** Black Duck marks a package Direct when the project's manifest declares it.
Trivy's lockfile parsers do not carry the manifest: for yarn.lock they mark direct whatever no other
package depends on, which on ruby-mastodon makes 25 declared packages Transitive Dependency and 18
packages of the `streaming` workspace Direct Dependency. Syft copies yarn berry's `0.0.0-use.local` workspace entries into
the SBOM, and a workspace's `dependsOn` edges are exactly its package.json — so when an SBOM carries
workspace nodes, those edges define Direct and the chains start from them; otherwise the lockfile
root's edges do, as before. For `pom.xml`, `go.mod` and `Cargo.lock`, Trivy nests the project's own
artifact under the manifest node; the walk is re-rooted on it and it never appears as a segment.

**Syft SBOMs carry chains only where they carry edges** — yarn workspaces and the maven module
reconstruction. Everything else (gems, Go modules, composer packages, and whatever no workspace
reaches) is emitted at the root level with a one-hop path. That is a real loss of information
relative to a Trivy SBOM, not a modelling choice.

### Upgrade guidance

Short term is the **newest stable version on the installed line** (same major) that clears every
fixable finding — every patch available without a breaking change; when that line has no clean
version, the lowest clean version above the installed one. Long term is the newest stable version
overall that clears every fixable finding. Both rules were read off a Black Duck export against our
own registry lists (127 of 136 testable short-term cells, 148 of 153 long-term ones; the rest are
versions published after Black Duck's Knowledge Base snapshot).

A source names one fix per maintained line (Trivy: `2.15.0, 2.12.2`, newest first) and all of them
are read: a candidate is fixed by the fix of *its* line, so `2.12.5` is clean and `2.13.0` is not.
A finding with no named fix cannot be cleared by any version; it is left out of the choice and
counted in the recommendation's remaining-vulnerability columns instead. A component whose findings
are *all* unfixed gets an empty recommendation — which is what Black Duck does for the same case.
Pre-releases are recommended only when nothing stable clears the findings. No network call is made;
the version list is the one the analysis already fetched, so an empty list (a registry that did not
answer) means an empty recommendation.

## Preprocess data
If you want to run `Depinder` on a project that has not been processed by `Depminer` before, 
you need to run the following command to generate the folder structure:

```shell
dxw depminer construct <path-to-dx-dependencies-folder> <path-to-exported-folder>
```

After doing this, some package managers will require some more post-processing, in order to generate the `dependency tree` or the `lock file`.

### Maven
To generate the `dependency tree` for a maven project, run the following command in each project (or root project in case they contain modules):

```shell
mvn dependency:tree -DoutputFile=deptree.txt
```
This command should create a `deptree.txt` file next to each `pom.xml` file.
This file will be processed by MavenMiner to generate the a `pom.json` file, that corresponds to the expectations that the `Depinder` Java plugin has.


### Gradle
To generate the `dependency tree` for a gradle project, run the following command in each project (or root project in case they contain modules):

```shell
gradle dependencies --configuration compileClasspath > deptree.txt
```
This command should create a `deptree.txt` file next to each `build.gradle` file.
This file will be processed by GradleMiner to generate the a `gradle.json` file, that corresponds to the expectations that the `Depinder` Java plugin has.

## Usage
The following commands can be used either as standalone, or with the `dxw` prefix ahead.

### Cache command

Registry answers are cached in one of two places: a **SQLite database global to the machine**,
`~/.dxw/depinder/cache/depinder.sqlite`, through Node's own `node:sqlite` (no native addon), or
MongoDB when its container is running.

```shell
depinder cache               # where the SQLite cache is and what it holds; is Mongo running?
depinder cache import <dir>  # pull a libs.json / misses.json folder into it
depinder cache init          # write the MongoDB docker-compose files to ~/.dxw/depinder/cache/
depinder cache up            # start MongoDB (alias: start)
depinder cache down          # stop it (alias: stop)
```

To see what is in MongoDB, visit the [Mongo Express Dashboard](http://localhost:8002/).

### The library cache

Without MongoDB, registry answers are kept in the `libs` table of the SQLite database, so a second
run over the same libraries — from any working directory — makes no registry calls. Lookups that
*failed* are kept too, in `misses`, for 24 hours: a library a registry cannot find — or a registry
that does not answer — would otherwise be asked again on every run, and a failed lookup is the
slowest kind. `--refresh` bypasses both. A rate-limited (429) lookup is never remembered as a miss.
Every row is committed as it is written, so the 60-second checkpoint costs nothing; the previous
`cache/libs.json` (94 MB on the twelve-repository run) was serialised whole at every one.

`DEPINDER_CACHE_DB=<file>` points a run at another database. The previous per-directory layout
(`cache/libs.json`, `misses.json`) is not read by a run any more;
`depinder cache import cache` copies it into the database, keeping rows already there.

Add `--profile` to `analyse` or `export-blackduck` to get, at the end of the run, the wall-clock
of each phase (parse, scans, registry enrichment, CSV writing), the cache hit/miss counts and the
number of HTTP requests made to each host.

### Analyse
To analyse a project, run the following command:

```shell
depinder analyse <paths-to-analysed-project-folders> ... -r <path-to-results-folder>
```
This command gets as an argument multiple fully qualified folder paths and will automatically run all plugins that are available for the project's used languages 
and export the results in the specified `results` folder.

### Export Black Duck-shaped CSVs

```shell
depinder export-blackduck <sbom-folders> ... -r <path-to-results-folder> --vuln-source trivy,grype,github
```

Runs the analysis above over a folder of CycloneDX SBOMs and writes Black Duck's five export files
alongside the normal depinder CSVs. See [Black Duck-shaped exports](#black-duck-shaped-exports).

## Acknowledgements

Packagist api calls were inspired by [packagist-api-client](https://www.npmjs.com/package/packagist-api-client).
Depinder also uses some libraries from `Snyk.io` to parse dependency files.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License

[Apache-2.0](https://choosealicense.com/licenses/apache)
