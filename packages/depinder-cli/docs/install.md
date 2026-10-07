# Installing

Pick your OS in any tab; every block on the page follows.

## 1. Node.js 24+

=== "macOS"

    ```bash
    brew install node
    ```

=== "Linux"

    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
    nvm install 24
    ```

=== "Windows"

    ```powershell
    winget install OpenJS.NodeJS
    ```

    Open a new terminal afterwards.

## 2. The CLI

=== "Standalone"

    ```bash
    npm i -g @dxworks/depinder
    depinder --version
    ```

=== "As a dxw plugin"

    ```bash
    dxw plugin i @dxworks/depinder
    dxw depinder --version
    ```

    Prefix every command on this site with `dxw`.

## 3. Scanners

The SBOM route gets vulnerabilities from local scanners. Neither is bundled. A missing one is
reported before the run, and the run completes without its findings. With the
[resolver token](#4-resolver-token-optional) set, the [vulnerability server](configuration.md#vulnerability-server)
scans the SBOMs instead, and the local scanners are only its fallback.

### Trivy

=== "macOS"

    ```bash
    brew install trivy
    ```

=== "Linux"

    ```bash
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sudo sh -s -- -b /usr/local/bin
    ```

=== "Windows"

    Download `trivy_<version>_windows-64bit.zip` from the
    [releases page](https://github.com/aquasecurity/trivy/releases/latest), unzip, and put
    `trivy.exe` on `PATH` or in `TRIVY_BIN`:

    ```powershell
    $env:TRIVY_BIN = "C:\tools\trivy\trivy.exe"
    ```

### Grype

=== "macOS"

    ```bash
    brew tap anchore/grype
    brew install grype
    ```

=== "Linux"

    ```bash
    curl -sSfL https://get.anchore.io/grype | sudo sh -s -- -b /usr/local/bin
    ```

=== "Windows"

    ```powershell
    winget install Anchore.Grype
    ```

    Or `scoop install main/grype`, or the release zip on `PATH` / in `GRYPE_BIN`.

The `github` source needs no binary, only [`github-advisories download`](commands/github-advisories.md).

!!! note
    Trivy and Grype update their own databases. Two runs on different days can find different
    vulnerabilities for the same SBOM. Depinder refreshes both once, before the first scan, so a
    folder of SBOMs scanned at once never has a dozen processes downloading the same database.

## 4. Resolver token (optional)

!!! tip "No token? No problem"
    The token is optional. Without it, depinder runs fully locally: package data comes straight
    from the registries and vulnerabilities from the Trivy and Grype installed in
    [step 3](#3-scanners). The results are the same; the run is only slower.

`analyse` asks the [bulk resolver](configuration.md#bulk-resolver) at `https://libs.dxworks.org`
first, which is much faster than asking every registry package by package. The server only answers
requests that carry its token, read from `DEPINDER_RESOLVER_TOKEN`. Set it once for every terminal:

=== "macOS"

    ```bash
    echo 'export DEPINDER_RESOLVER_TOKEN=<token>' >> ~/.zshrc
    source ~/.zshrc
    ```

=== "Linux"

    ```bash
    echo 'export DEPINDER_RESOLVER_TOKEN=<token>' >> ~/.bashrc
    source ~/.bashrc
    ```

=== "Windows"

    ```powershell
    setx DEPINDER_RESOLVER_TOKEN "<token>"
    ```

    Open a new terminal afterwards.

Check that a new terminal sees it, without printing it:

=== "macOS"

    ```bash
    echo ${DEPINDER_RESOLVER_TOKEN:+set}
    ```

=== "Linux"

    ```bash
    echo ${DEPINDER_RESOLVER_TOKEN:+set}
    ```

=== "Windows"

    ```powershell
    if ($env:DEPINDER_RESOLVER_TOKEN) { "set" }
    ```

!!! warning "The token is a secret"
    Keep it in your shell profile or a secret store. Never commit it, paste it in an issue, or put
    it in a script that is shared.

Without the token, depinder still works: each run warns once, fetches everything from the
registries and scans the SBOMs with the local Trivy and Grype. `--no-resolver` skips the resolver
and the warning.

## From source

```bash
git clone https://github.com/dxworks/depinder
cd depinder
npm ci
npx nx build depinder-cli
cd packages/depinder-cli && npm link
```

The repository is an Nx monorepo; the CLI lives in `packages/depinder-cli` and builds to its
`dist/`. `npm link` puts that build on `PATH` as `depinder`, and a later `npx nx build depinder-cli`
updates it in place. Without linking, run the build directly, from the repository root:

```bash
node packages/depinder-cli/dist/index.js --version
node packages/depinder-cli/dist/index.js analyse /path/to/depminer/results -r results
```

Steps 1, 3 and 4 above apply to a source build too.
