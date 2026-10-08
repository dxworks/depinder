# Depinder

Depinder reads CycloneDX SBOMs (from Syft or Trivy, as [DepMiner](https://dxworks.org/depminer/)
produces them) and reports each dependency's licences, newer versions and known vulnerabilities,
as CSVs and as Black Duck-shaped exports.

The documentation is at **<https://dxworks.org/depinder/>**: installing the scanners, every
command and option, the output files, configuration.

## Install

Node.js 24 or newer.

```shell
npm i -g @dxworks/depinder
depinder --version
```

Or as a `dxw` plugin: `dxw plugin i @dxworks/depinder`, then prefix every command with `dxw`.

## Example

```shell
depinder analyse ./depminer/results -r results
```

Writes one subfolder per SBOM source (`results/trivy/`, `results/syft/`). See the
[Quick Start](https://dxworks.org/depinder/quickstart/) for tokens, scanners and the output.

## License

Apache-2.0
