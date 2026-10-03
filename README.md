# depinder

Dependency analysis for CycloneDX SBOMs: licences, newer versions, vulnerabilities, and Black
Duck-shaped CSV exports.

This repository is an [Nx](https://nx.dev) monorepo (npm workspaces, Node 24):

| Project | Path | What it is |
|---|---|---|
| `depinder-cli` | [`packages/depinder-cli`](packages/depinder-cli) | The `depinder` command line tool, published to npm as [`@dxworks/depinder`](https://www.npmjs.com/package/@dxworks/depinder). Usage: [its README](packages/depinder-cli/README.md) and the [documentation site](https://dxworks.org/depinder/). |
| `workspace-checks` | [`tools/workspace-checks`](tools/workspace-checks) | Repo-wide guards: file and function sizes, one version of every dependency. |

## Install

```bash
npm install -g @dxworks/depinder
depinder --help
```

## Develop

```bash
nvm use                       # Node 24, from .nvmrc
npm ci
npx nx run-many -t typecheck lint test build size-guard dependency-check   # what CI runs (npm run check)
npx nx build depinder-cli     # packages/depinder-cli/dist
npx nx run depinder-cli:docs  # MkDocs site, needs `pip install -r packages/depinder-cli/requirements-docs.txt`
```

Size limits for new and moved code: files ~350 lines (hard 400), tests ~500 (hard 550),
functions ~100. `workspace-checks:size-guard` measures files and the `max-lines-per-function` lint
rule measures functions; files that were already longer are listed in
`tools/workspace-checks/size-baseline.json` and may shrink but not grow.
`workspace-checks:dependency-check` fails when the workspace holds two versions of a dependency.

## License

[Apache-2.0](LICENSE)
