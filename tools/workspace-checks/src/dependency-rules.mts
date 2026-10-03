// One version of every dependency across the workspace (NX_MIGRATION.md D16), so every project
// runs the same library code.

export interface Manifest {
    /** Repo-relative folder of the project ('' for the root). */
    location: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
}

/** package-lock.json `packages`: install path → what is installed there. */
export type LockPackages = Record<string, {version?: string, link?: boolean}>

export interface DependencyReport {
    errors: string[]
    notes: string[]
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/** Every dependency a workspace project declares, with each project's range for it. */
export function declaredRanges(manifests: Manifest[]): Map<string, Map<string, string>> {
    const ranges = new Map<string, Map<string, string>>()
    for (const manifest of manifests) {
        for (const section of SECTIONS) {
            for (const [name, range] of Object.entries(manifest[section] ?? {})) {
                const byProject = ranges.get(name) ?? new Map<string, string>()
                byProject.set(`${manifest.location || '<root>'} ${section}`, range)
                ranges.set(name, byProject)
            }
        }
    }
    return ranges
}

/** The installed copies of a package: install path → version. */
export function installedCopies(lock: LockPackages, name: string): Map<string, string> {
    const copies = new Map<string, string>()
    for (const [installPath, entry] of Object.entries(lock)) {
        if (entry.link || !entry.version) continue
        if (installPath === `node_modules/${name}` || installPath.endsWith(`/node_modules/${name}`)) copies.set(installPath, entry.version)
    }
    return copies
}

/** Copies a workspace project itself resolves: hoisted to the root, or in a project's own node_modules. */
function resolvableByProjects(installPath: string, name: string, projectLocations: string[]): boolean {
    return installPath === `node_modules/${name}`
        || projectLocations.some(location => location && installPath === `${location}/node_modules/${name}`)
}

const major = (version: string) => version.split('.')[0]

/**
 * Errors: a dependency declared with different ranges by two projects; installed in two versions
 * that projects resolve; or a nested copy in the same major as the projects' own version (aligning
 * the ranges would dedupe it). A nested copy of another major belongs to the third-party package
 * that needs it and is only noted.
 */
export function checkDependencies(manifests: Manifest[], lock: LockPackages): DependencyReport {
    const report: DependencyReport = {errors: [], notes: []}
    const projectLocations = manifests.map(it => it.location)
    for (const [name, byProject] of declaredRanges(manifests)) {
        const distinctRanges = new Set(byProject.values())
        if (distinctRanges.size > 1) {
            const where = [...byProject].map(([project, range]) => `${project} ${range}`).join(', ')
            report.errors.push(`${name} is declared with different ranges: ${where}`)
        }
        const copies = [...installedCopies(lock, name)]
        const isOwn = ([installPath]: [string, string]) => resolvableByProjects(installPath, name, projectLocations)
        const ownVersions = new Set(copies.filter(isOwn).map(([, version]) => version))
        if (ownVersions.size > 1) report.errors.push(`${name} resolves to different versions in workspace projects: ${[...ownVersions].join(', ')}`)
        for (const [installPath, version] of copies.filter(copy => !isOwn(copy))) {
            const sameMajor = [...ownVersions].filter(own => own !== version && major(own) === major(version))
            if (sameMajor.length > 0) {
                report.errors.push(`${name} ${version} at ${installPath} duplicates the workspace's ${sameMajor.join(', ')}`)
            } else if (!ownVersions.has(version)) {
                report.notes.push(`${name} ${version} at ${installPath}: another major, private to that package`)
            }
        }
    }
    return report
}
