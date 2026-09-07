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

`export-blackduck` turns a folder of CycloneDX SBOMs into the five CSVs a Black Duck project
version exports, with Black Duck's exact column headers, so the two can be diffed side by side.

```shell
depinder export-blackduck <sbom-folder...> -r <out> \
    [--vuln-source trivy,grype,github] [--github-token-file F] [--project-name NAME]
```

It runs the same analysis `analyse` runs — dependency tree, registry licences and versions,
vulnerabilities from the selected sources — and writes the normal depinder CSVs into the same
folder, then the five Black Duck files on top. You do not name plugins: the ecosystems present in
the SBOMs select the `sbom-*` plugins for you.

| File | One row per | Notes |
|---|---|---|
| `_dependencies.csv` | (component, version, origin) | The first header really is `1Component name` — Black Duck's own spelling, reproduced verbatim so a diff lines up |
| `_dependencies_sources.csv` | (component, path) | The dependency chain, walked from the SBOM's `dependsOn` edges |
| `_upgrade_guidance.csv` | component with ≥ 1 finding | Short/long term recommended versions |
| `_vulnerability_details.csv` | (component, advisory) | |
| `security.csv` | (component, advisory) | The same rows plus Black Duck's internal ids, triage fields and CISA block, all empty for us. `analyse` writes this one file too, through the same serialiser |

### Column mapping

Where a column is not derivable from an SBOM plus a public registry, it is written **empty** rather
than guessed.

| Black Duck column | Our source | Derivation |
|---|---|---|
| `1Component name` / `Component name` | SBOM purl | The registry name. Black Duck's is a Knowledge Base *display* name (`Action Mailer` for `actionmailer`), so the two never match — join on the origin id instead |
| `Component version name` | SBOM purl | verbatim |
| `Component Version Origin Id` | SBOM purl | `name/version` for npmjs, rubygems, pypi, nuget, crates; `name:version` for maven, packagist, github — read off the real export, not guessed |
| `Origin name` | purl type | `npm`→`npmjs`, `gem`→`rubygems`, `composer`→`packagist`, `cargo`→`crates`, `golang`→`github`, else the purl type; unmapped → `unknown` |
| `License names` | registrar, else the SBOM | SPDX id mapped to Black Duck's display name (`MIT` → `MIT License`); an unmapped id is written as-is so it stays visible. Black Duck collapses `MIT-0` into `MIT License`; we keep the distinct name |
| `License families` | the same table | `PERMISSIVE` / `WEAK_RECIPROCAL` / `RECIPROCAL` / `RESTRICTED_PROPRIETARY` / `UNKNOWN` |
| `Match type` | `requestedBy` | `Direct` / `Transitive` / `Direct,Transitive` — the rule `<plugin>-libs.csv` already uses, made three-valued |
| `Usage` | — | Constant `DYNAMICALLY_LINKED`, which is what Black Duck writes for every row of a dependency scan |
| `Operational Risk` | — | **empty, not derivable** — Black Duck's own risk model |
| `License Risk` | — | **empty, not derivable** — same |
| `Total` / `Critical and High` / `Critical` / `High` / `Medium` / `Low Vulnerability Count` | findings | Counted from the merged findings. Black Duck leaves a per-severity cell blank when it is 0; we always write the number |
| `Release Date` | registrar | ISO `YYYY-MM-DD`. Black Duck's cell carries a leading TAB; we do not reproduce it |
| `Newer Versions` | registrar | Registry versions ordered above the installed one, using the ecosystem's comparator. Empty when no registrar answered |
| `Commit Activity`, `Commits in Past 12 Months`, `Contributors in Past 12 Months`, `Open Hub URL` / `OpenHubURL` | — | **empty, not derivable** — Open Hub data |
| `Has License Conflicts` | — | Constant `false`; we run no licence-conflict analysis |
| `Component Link` | registrar homepage, else registry | The registrar's `homepageUrl`, falling back to a registry page URL built from the coordinates (maven has none we can derive) |
| `Path` | SBOM `dependsOn` | `<project>/-<package manager>/<name>/<version>/…` — see *Dependency paths* below |
| `ProjectPath` | — | The project name, plus `/<module>` when the SBOM names its modules |
| `ProjectPathExists`, `VerifiedPath` | — | **empty** — Black Duck leaves them empty too |
| `Vulnerability id` | findings | `GHSA-… (CVE-…)` when both are known, else the single id — Black Duck's `BDSA-… (CVE-…)` shape. We have no BDSA numbers |
| `Vulnerability source` | finding origin | `GHSA` (advisory cache), `TRIVY`, `GRYPE`. A finding two sources agree on reports the advisory database, since that is the one that names it |
| `Description`, `Published on`, `Base score`, `URL`, `Security Risk` | findings | verbatim from the source |
| `Updated on`, `Exploitability`, `Impact`, `Overall score` | — | **empty, not derivable** — Black Duck's own scoring breakdown |
| `CWE Ids` | findings | Black Duck's list syntax, `[CWE-400, CWE-834]` |
| `Solution available` | findings | `true` when the source named a fixed version |
| `Workaround available` | — | **empty, not derivable** |
| `Exploit available` | — | **empty** — CISA KEV is not wired up, so this is unknown rather than `false` |
| `CVSS Version` | CVSS vector prefix | `CVSS 3.x` / `CVSS 4` (Black Duck's spellings) / `CVSS 2.x` for a prefix-less v2 vector |
| `Match type` (vulnerability files) | `requestedBy` | `Direct Dependency` / `Transitive Dependency` — Black Duck's wording in these files |
| `Remediation status` | — | Constant `New`; we hold no triage state |
| `Vulnerability tags`, `Reachable`, `Status justification`, remediation dates, all `CISA *` | — | **empty, not derivable** |
| `Short/Long Term Recommended *` | registry versions + fixed versions | See *Upgrade guidance* below |

### Dependency paths

`Path` is walked from the SBOM's own `dependencies[].dependsOn` edges, from the same project nodes
the parser builds projects from, so `Direct` in `_dependencies.csv` and a one-segment path here are
the same statement. Black Duck writes **one row per (component, project)** — the shortest chain
from the manifest to the component (1,122 rows for ruby-mastodon's 1,239 components) — and so do
we: a package pulled in by two parents appears once, under whichever reaches it soonest.

The tag after the project is the **package manager whose manifest was walked**, in Black Duck's
spelling: `-yarn`, `-npm` and `-pnpm` for the three JavaScript lockfiles, `-rubygems`, `-maven`,
`-gradle`, `-packagist`, `-cargo`, `-go_mod`, `-nuget`, `-uv`, `-pip`. It is read off the manifest's
basename — Trivy names its `application` node after the manifest, Syft records each component's
`syft:location:0:path` — and falls back to the origin name when neither tool recorded one.

**What is direct.** Black Duck marks a package Direct when the project's manifest declares it.
Trivy's lockfile parsers do not carry the manifest: for yarn.lock they mark direct whatever no other
package depends on, which on ruby-mastodon makes 25 declared packages Transitive and 18 packages of
the `streaming` workspace Direct. Syft copies yarn berry's `0.0.0-use.local` workspace entries into
the SBOM, and a workspace's `dependsOn` edges are exactly its package.json — so when an SBOM carries
workspace nodes, those edges define Direct and the chains start from them; otherwise the lockfile
root's edges do, as before. For `pom.xml`, `go.mod` and `Cargo.lock`, Trivy nests the project's own
artifact under the manifest node; the walk is re-rooted on it and it never appears as a segment.

**Syft SBOMs carry chains only where they carry edges** — yarn workspaces and the maven module
reconstruction. Everything else (gems, Go modules, composer packages, and whatever no workspace
reaches) is emitted at the root level with a one-hop path. That is a real loss of information
relative to a Trivy SBOM, not a modelling choice.

### Upgrade guidance

Short term is the lowest registry version at or above the installed one that clears every finding;
long term is the highest version that clears every finding. "Clears" is deliberately conservative:
a finding is cleared only when its source **named a first patched version** and the candidate is at
or above it. A component carrying a finding with no named fix gets an empty recommendation — which
is what Black Duck does for the same case. No network call is made; the version list is the one the
analysis already fetched.

### Reproducing the comparison

```shell
# (a) Download the GitHub advisories these SBOMs need (needs tokens in .github-tokens)
depinder github-advisories download --sbom /path/to/sboms
depinder github-advisories status

# (b) Score the three vulnerability sources against each other over the reference corpus
npx ts-node -T scripts/compare-vuln-sources.ts
#   -> <comparison>/results/vuln-source-comparison.{md,json}

# (c) Export, once per SBOM producer
depinder export-blackduck /path/to/mastodon-trivy \
    -r <comparison>/exports/ruby-mastodon-trivy \
    --vuln-source trivy,grype,github --project-name ruby-mastodon
depinder export-blackduck /path/to/mastodon-syft \
    -r <comparison>/exports/ruby-mastodon-syft \
    --vuln-source trivy,grype,github --project-name ruby-mastodon

# (d) Diff our export against the real Black Duck one
npx ts-node -T scripts/diff-blackduck-export.ts
#   -> <comparison>/results/blackduck-export-diff.md
```

Both scripts default to the paths of the local comparison checkout; pass
`<ours> <theirs> [<output>]` to point the diff elsewhere.

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

To check if the MongoDB cache is running:
```shell
depinder cache
```

To initalise the Redis cache:
```shell
depinder cache init
```

To start the MongoDB cache:
```shell
depinder cache start
```

To stop the MongoDB cache:
```shell
depinder cache stop
```

To see what is available in the cache, please visit the [Mongo Express Dashboard](http://localhost:8002/).

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
