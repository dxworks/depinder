import fs from 'fs'
import path from 'path'
import type {PurlCoordinates} from '../plugins/sbom/purl'

/**
 * Repository manifests, read from DepMiner's results (see `depminer-index.ts`), identify own code
 * to omit from dependency source paths.
 *
 * A pnpm or yarn workspace member (`docs@0.0.0`), the uv project itself (`example-app@1.0a0`),
 * or the Cargo crate (`example-cli@1.0.0`) can appear in the SBOM as an ordinary component:
 * `manifest -> own package -> library -> transitive dependency`.
 * Black Duck treats the own package as a project and starts the chain at the library. We omit
 * it from `_dependencies_sources.csv` rows and chains too, leaving the edge table unchanged.
 * SBOM self-anchors are handled in `paths.ts`; manifests identify additional own packages.
 * A matching manifest's ecosystem, name and version establish ownership. Python versions are
 * normalised, so pyproject's `1.0-a.0` matches the SBOM's `1.0a0`.
 *
 * Own code is a property of a tree, not of the repository: `@example/core` declared at the root
 * is own code in the root `package-lock.json` tree. In `tools/benchmarks`, which has a lockfile
 * of its own, that same package is an external dependency. A manifest belongs to the nearest
 * enclosing directory that holds a lockfile of the same family, and to no tree beyond it.
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

/** Repo-relative path (`/`-separated) -> the file on disk that holds its content. */
export type RepoFiles = Map<string, string>

/** Reads every manifest it recognises among one repository's files. */
export function readRepoManifests(files: RepoFiles): RepoManifests {
    const manifests: RepoManifest[] = []
    const lockDirs = new Set<string>()
    for (const relative of files.keys()) {
        const dir = path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative)
        if (dir.split('/').some(segment => SKIPPED_DIRS.has(segment))) continue
        const base = path.posix.basename(relative)
        for (const family of FAMILIES) {
            if (family.lockfiles.test(base)) lockDirs.add(`${family.purlType}\0${dir}`)
            if (family.manifests.test(base)) {
                const read = readManifest(files, relative, family.purlType)
                manifests.push({dir, file: base, purlType: family.purlType, ...read})
            }
        }
    }
    manifests.sort((a, b) => a.dir.localeCompare(b.dir) || a.file.localeCompare(b.file))
    return {manifests, lockDirs}
}

function readManifest(files: RepoFiles, relative: string, purlType: string): {name?: string, version?: string} {
    const text = readText(files.get(relative))
    if (text === undefined) return {}
    const base = path.posix.basename(relative)
    try {
        if (base === 'package.json' || base === 'composer.json') {
            const json = JSON.parse(text)
            return {name: str(json.name), version: str(json.version)}
        }
        if (base === 'pyproject.toml') return tomlSection(text, 'project') ?? tomlSection(text, 'tool.poetry') ?? {}
        if (base === 'Cargo.toml') return tomlSection(text, 'package') ?? {}
        if (base === 'go.mod') return {name: text.match(/^module\s+(\S+)/m)?.[1]}
        if (base === 'pom.xml') return pomCoordinates(text)
        if (base.startsWith('build.gradle')) return gradleCoordinates(files, path.posix.dirname(relative), text)
        if (purlType === 'nuget') return {name: base.replace(/\.(csproj|fsproj|vbproj)$/, '')}
    } catch {
        return {}
    }
    return {}
}

function readText(file: string | undefined): string | undefined {
    if (!file) return undefined
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return undefined
    }
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
function gradleCoordinates(files: RepoFiles, dir: string, text: string): {name?: string, version?: string} {
    let name: string | undefined
    for (const settings of ['settings.gradle', 'settings.gradle.kts']) {
        name = readText(files.get(path.posix.join(dir, settings)))?.match(/rootProject\.name\s*=\s*["']([^"']+)["']/)?.[1]
        if (name) break
    }
    const version = text.match(/^version\s*=?\s*["']([^"']+)["']/m)?.[1]
    return {name, version}
}

/**
 * Whether a component of `purlType` reached inside the tree at `treeDir` is the repository's own
 * code — declared by a manifest of the same family inside the tree, and not inside a nested tree
 * of that family. A manifest without a version claims the name alone.
 */
export function ownCodeMatcher(repo: RepoManifests | undefined, treeDir: string, purlType: string): (component: PurlCoordinates | undefined) => boolean {
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
