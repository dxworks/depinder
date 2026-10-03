# depinder

Dependency analysis for CycloneDX SBOMs: licences, newer versions, vulnerabilities, and Black
Duck-shaped CSV exports.

This repository is an [Nx](https://nx.dev) monorepo (npm workspaces, Node 24):

| Project | Path | What it is |
|---|---|---|
| `depinder-cli` | [`packages/depinder-cli`](packages/depinder-cli) | The `depinder` command line tool, published to npm as [`@dxworks/depinder`](https://www.npmjs.com/package/@dxworks/depinder). Usage: [its README](packages/depinder-cli/README.md) and the [documentation site](https://dxworks.org/depinder/). |

## Install

```bash
npm install -g @dxworks/depinder
depinder --help
```

## Develop

```bash
nvm use                       # Node 24, from .nvmrc
npm ci
npx nx run-many -t typecheck lint test build
npx nx build depinder-cli     # packages/depinder-cli/dist
npx nx run depinder-cli:docs  # MkDocs site, needs `pip install -r packages/depinder-cli/requirements-docs.txt`
```

## License

[Apache-2.0](LICENSE)
