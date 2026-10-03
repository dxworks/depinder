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
reported before the run, and the run completes without its findings.

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

## From source

```bash
git clone https://github.com/dxworks/depinder
cd depinder
npm install
npm run build
npm link
```

On Windows, `npm run clean:modules` and `npm run refresh` need Git Bash or WSL.
