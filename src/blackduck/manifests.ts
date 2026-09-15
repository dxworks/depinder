import fs from 'fs'
import path from 'path'
import {ParsedPurl} from '../plugins/sbom/cyclonedx'

/**
 * What the scanned repository says about itself, read off its manifests on disk.
 *
 * Two things in the Black Duck export cannot be read from an SBOM, and both come from here:
 *
 *  1. **The project prefix of `Path`.** Black Duck writes
 *     `<project name>/<project version>/<dir relative to the scan root>/-<pm>/<chain>`, and the
 *     name and version are the manifest's — `n8n-monorepo/2.37.0/js-pnpm-n8n/-pnpm/…`,
 *     `saleor/3.24.0a0/…/-uv/…`, `PublicApi/dotnet-eshoponweb/src/PublicApi/PublicApi.csproj/-nuget/…`.
 *     Neither Syft nor Trivy records a lockfile's own name or version.
 *  2. **Own code.** A pnpm or yarn workspace member (`docs@0.0.0`), the uv project itself
 *     (`saleor@3.24.0a0`), the Cargo crate (`ripgrep@15.2.0`) sit in the SBOM as ordinary
 *     components, on the chain between the manifest and the real dependencies. Black Duck does
 *     not list them: it treats each as a project of its own and starts the chain after it. The
 *     only place that says a component is the repository's own is a manifest under the
 *     repository that declares that name.
 *
 * Own code is a property of a tree, not of the repository: `@nestjs/core` is own code in the
 * root `package-lock.json` tree of nest and a real dependency of `tools/benchmarks`, which has
 * a lockfile of its own. So a manifest belongs to the nearest enclosing directory that holds a
 * lockfile of the same family, and to no tree beyond it.
 *
 * The prefix shapes below were read off one real export (`zzy-v050-split-output`, 10,188 rows),
 * per package manager tag, and nothing was inferred by analogy. Where Detect writes something no
 * manifest can explain — `eShopOnWeb/…` solution-level duplicates next to the per-project rows,
 * the air-gap `../instruments/…` path of its uv detector, the `<workspace dir>/local/<root>`
 * sub-projects of a yarn workspace — the plain `<dir>` prefix stays.
 */

export interface RepoManifest {
    /** Repo-relative directory of the manifest, `''` at the root. */
    dir: string
    /** The manifest's basename. */
    file: string
    /** The purl type of what this manifest's package manager produces: npm, pypi, maven, … */
    purlType: string
    name?: string
    version?: string
}

export interface RepoManifests {
    manifests: RepoManifest[]
    /** `<purlType>\0<dir>` for every directory holding a lockfile of that family: a tree of its own. */
    lockDirs: Set<string>
}

const SKIPPED_DIRS = new Set([
    'node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'out', '.venv', 'venv',
    '__pycache__', 'bin', 'obj', '.gradle', '.idea', '.next', 'coverage',
])

/** Manifest basename -> family, and the lockfiles that make a directory a tree of that family. */
const FAMILIES: {purlType: string, manifests: RegExp, lockfiles: RegExp}[] = [
    {purlType: 'npm', manifests: /^package\.json$/, lockfiles: /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/},
    {purlType: 'pypi', manifests: /^pyproject\.toml$/, lockfiles: /^(uv\.lock|poetry\.lock|Pipfile\.lock|requirements.*\.txt)$/},
    {purlType: 'cargo', manifests: /^Cargo\.toml$/, lockfiles: /^Cargo\.lock$/},
    {purlType: 'maven', manifests: /^(pom\.xml|build\.gradle(\.kts)?)$/, lockfiles: /^(pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile)$/},
    {purlType: 'golang', manifests: /^go\.mod$/, lockfiles: /^go\.(mod|sum)$/},
    {purlType: 'nuget', manifests: /^.*\.(csproj|fsproj|vbproj)$/, lockfiles: /^(.*\.(csproj|fsproj|vbproj)|packages\.lock\.json)$/},
    {purlType: 'gem', manifests: /^Gemfile$/, lockfiles: /^Gemfile\.lock$/},
    {purlType: 'composer', manifests: /^composer\.json$/, lockfiles: /^composer\.lock$/},
]

/** The family a `Path` tag (`-yarn`, `-uv`, `-gradle`, …) belongs to. */
export function familyOfTag(tag: string): string {
    switch (tag) {
    case 'npm': case 'yarn': case 'pnpm': return 'npm'
    case 'uv': case 'pip': case 'poetry': return 'pypi'
    case 'maven': case 'gradle': return 'maven'
    case 'go_mod': return 'golang'
    case 'rubygems': return 'gem'
    case 'packagist': return 'composer'
    default: return tag
    }
}

/** Walks the repository once and reads every manifest it recognises. */
export function readRepoManifests(repoDir: string): RepoManifests | undefined {
    if (!repoDir || !fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) return undefined
    const manifests: RepoManifest[] = []
    const lockDirs = new Set<string>()
    const walk = (dir: string) => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        const rel = path.relative(repoDir, dir).split(path.sep).join('/')
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
                continue
            }
            if (!entry.isFile()) continue
            for (const family of FAMILIES) {
                if (family.lockfiles.test(entry.name)) lockDirs.add(`${family.purlType}\0${rel}`)
                if (family.manifests.test(entry.name)) {
                    const read = readManifest(path.join(dir, entry.name), family.purlType)
                    manifests.push({dir: rel, file: entry.name, purlType: family.purlType, ...read})
                }
            }
        }
    }
    walk(repoDir)
    manifests.sort((a, b) => a.dir.localeCompare(b.dir) || a.file.localeCompare(b.file))
    return {manifests, lockDirs}
}

function readManifest(file: string, purlType: string): {name?: string, version?: string} {
    let text: string
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return {}
    }
    const base = path.basename(file)
    try {
        if (base === 'package.json' || base === 'composer.json') {
            const json = JSON.parse(text)
            return {name: str(json.name), version: str(json.version)}
        }
        if (base === 'pyproject.toml') return tomlSection(text, 'project') ?? tomlSection(text, 'tool.poetry') ?? {}
        if (base === 'Cargo.toml') return tomlSection(text, 'package') ?? {}
        if (base === 'go.mod') return {name: text.match(/^module\s+(\S+)/m)?.[1]}
        if (base === 'pom.xml') return pomCoordinates(text)
        if (base.startsWith('build.gradle')) return gradleCoordinates(file, text)
        if (purlType === 'nuget') return {name: base.replace(/\.(csproj|fsproj|vbproj)$/, '')}
    } catch {
        return {}
    }
    return {}
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** `name` and `version` of one `[section]` of a TOML file — enough for pyproject and Cargo. */
function tomlSection(text: string, section: string): {name?: string, version?: string} | undefined {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex(line => line.trim() === `[${section}]`)
    if (start < 0) return undefined
    const result: {name?: string, version?: string} = {}
    for (const line of lines.slice(start + 1)) {
        if (/^\s*\[/.test(line)) break
        const match = line.match(/^\s*(name|version)\s*=\s*["']([^"']*)["']/)
        if (match) result[match[1] as 'name' | 'version'] = match[2]
    }
    return result
}

/**
 * `groupId:artifactId` and `version` of the project a POM describes, its own before its parent's.
 * The `<parent>` block is consulted only for what the project leaves out, as Maven does.
 */
function pomCoordinates(text: string): {name?: string, version?: string} {
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '')
    const parentBlock = withoutComments.match(/<parent>([\s\S]*?)<\/parent>/)?.[1] ?? ''
    // Everything nested — parent, dependencies, build, profiles — must not supply the project's
    // own coordinates, so only what remains at the top level after removing those blocks counts.
    const own = withoutComments
        .replace(/<parent>[\s\S]*?<\/parent>/, '')
        .replace(/<(dependencyManagement|dependencies|build|profiles|reporting|pluginManagement|plugins)>[\s\S]*?<\/\1>/g, '')
    const tag = (source: string, name: string) => source.match(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`))?.[1]
    const groupId = tag(own, 'groupId') ?? tag(parentBlock, 'groupId')
    const artifactId = tag(own, 'artifactId')
    const version = tag(own, 'version') ?? tag(parentBlock, 'version')
    return {name: groupId && artifactId ? `${groupId}:${artifactId}` : artifactId, version}
}

/**
 * `rootProject.name` from the settings file beside the build script, and `version` from the script.
 * Only an unindented `version` is the project's: one inside a block (a plugin's, a dependency's)
 * is not, and Black Duck writes `unspecified` for teammates, whose only `version` is such a one.
 */
function gradleCoordinates(file: string, text: string): {name?: string, version?: string} {
    const dir = path.dirname(file)
    let name: string | undefined
    for (const settings of ['settings.gradle', 'settings.gradle.kts']) {
        const settingsFile = path.join(dir, settings)
        if (!fs.existsSync(settingsFile)) continue
        name = fs.readFileSync(settingsFile, 'utf8').match(/rootProject\.name\s*=\s*["']([^"']+)["']/)?.[1]
        if (name) break
    }
    const version = text.match(/^version\s*=?\s*["']([^"']+)["']/m)?.[1]
    return {name, version}
}

/** The manifest of one tree: the one of the tag's family that sits in the tree's own directory. */
export function manifestOfTree(repo: RepoManifests | undefined, treeDir: string, tag: string): RepoManifest | undefined {
    const family = familyOfTag(tag)
    const candidates = (repo?.manifests ?? []).filter(m => m.dir === treeDir && m.purlType === family)
    if (family === 'maven') {
        // A directory with both a POM and a Gradle script is described by the one the tag names.
        const wanted = tag === 'gradle' ? /^build\.gradle/ : /^pom\.xml$/
        return candidates.find(m => wanted.test(m.file)) ?? candidates[0]
    }
    return candidates[0]
}

/**
 * The part of `Path` before `-<tag>/`, as Black Duck writes it for this tree. `projectPath` is
 * `<repo>` or `<repo>/<dir>`, which is what the plain prefix is when there is nothing to add.
 *
 * Read off the reference export, tag by tag:
 *   pnpm     `n8n-monorepo/2.37.0/js-pnpm-n8n/`; a package.json without a version → `./js-pnpm-n8n/.github/scripts/`
 *   npm      `@nestjs/benchmarks/1.0.0/js-npm-nest/tools/benchmarks/`; name without version → `teammates-dev-docs/java-gradle-teammates/docs/`
 *   uv       `saleor/3.24.0a0/<dir>/` — the pypi-normalised version, not the pyproject spelling
 *   nuget    `PublicApi/dotnet-eshoponweb/src/PublicApi/PublicApi.csproj/`
 *   maven    `org.springframework.samples:spring-petclinic:4.0.0-SNAPSHOT:java-maven-spring-petclinic:`
 *   gradle   `java-gradle-teammates:unspecified:` — no directory segment
 *   go_mod   `github.com/caddyserver/caddy/v2:go-caddy:`
 *   yarn, rubygems, packagist, cargo, pip   the plain directory
 * Without manifests (no `--target`), every tag gets the plain directory, as before.
 */
export function blackDuckPrefix(tag: string, projectPath: string, manifest: RepoManifest | undefined): string {
    const plain = `${projectPath}/`
    if (!manifest) return plain
    const {name, version} = manifest
    switch (tag) {
    case 'pnpm':
        return name && version ? `${name}/${version}/${projectPath}/` : `./${projectPath}/`
    case 'npm':
        if (name && version) return `${name}/${version}/${projectPath}/`
        return name ? `${name}/${projectPath}/` : plain
    case 'uv': case 'poetry':
        return name && version ? `${name}/${pep440(version)}/${projectPath}/` : plain
    case 'nuget':
        return name ? `${name}/${projectPath}/${manifest.file}/` : plain
    case 'maven':
        return name && version ? `${name}:${version}:${projectPath}:` : plain
    case 'gradle':
        return `${name ?? path.posix.basename(projectPath)}:${version ?? 'unspecified'}:`
    case 'go_mod':
        return name ? `${name}:${projectPath}:` : plain
    default:
        return plain
    }
}

/**
 * Whether a component of `purlType` reached inside the tree at `treeDir` is the repository's own
 * code — declared by a manifest of the same family inside the tree, and not inside a nested tree
 * of that family. A manifest without a version claims the name alone.
 */
export function ownCodeMatcher(repo: RepoManifests | undefined, treeDir: string, purlType: string): (component: ParsedPurl | undefined) => boolean {
    if (!repo) return () => false
    const family = purlType
    const inTree = (dir: string) => treeDir === '' || dir === treeDir || dir.startsWith(`${treeDir}/`)
    const nestedTree = (dir: string) => {
        // Every directory from the manifest's own up to, but excluding, the tree's: a lockfile of
        // the family there makes the manifest somebody else's own code.
        let current = dir
        while (current !== treeDir) {
            if (repo.lockDirs.has(`${family}\0${current}`)) return true
            if (current === '') break
            const slash = current.lastIndexOf('/')
            current = slash < 0 ? '' : current.slice(0, slash)
        }
        return false
    }
    const own = repo.manifests
        .filter(m => m.purlType === family && m.name && inTree(m.dir) && !nestedTree(m.dir))
        .map(m => ({name: canonicalName(family, m.name as string), version: m.version && canonicalVersion(family, m.version)}))
    if (own.length === 0) return () => false
    return component => {
        if (!component || component.type !== family) return false
        const name = canonicalName(family, component.name)
        const version = canonicalVersion(family, component.version)
        return own.some(it => it.name === name && (!it.version || it.version === version))
    }
}

function canonicalName(family: string, name: string): string {
    return family === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name
}

function canonicalVersion(family: string, version: string): string {
    if (family === 'pypi') return pep440(version)
    if (family === 'golang') return version.replace(/^v/, '')
    return version
}

/**
 * The PEP 440 normal form, as far as project versions go: `3.24.0-a.0` → `3.24.0a0`. The SBOMs
 * carry the normalised spelling (it is what uv writes into its lockfile); pyproject carries the
 * author's.
 */
export function pep440(version: string): string {
    const PRE: Record<string, string> = {alpha: 'a', a: 'a', beta: 'b', b: 'b', preview: 'rc', pre: 'rc', rc: 'rc', c: 'rc'}
    let v = version.trim().toLowerCase().replace(/^v/, '')
    // Longest spellings first, so `beta` is not read as `b` + `eta`, nor `preview` as `pre`.
    v = v.replace(/[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d+)/, (_, kind, n) => `${PRE[kind]}${n}`)
    v = v.replace(/[-_.]?(alpha|beta|preview|pre|rc|a|b|c)$/, (_, kind) => `${PRE[kind]}0`)
    v = v.replace(/[-_.]?(post|rev|r)[-_.]?(\d+)/, (_, __, n) => `.post${n}`)
    v = v.replace(/[-_.]?dev[-_.]?(\d+)/, (_, n) => `.dev${n}`)
    return v
}
