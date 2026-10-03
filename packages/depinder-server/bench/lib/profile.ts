/**
 * Reads the `Profile:` block depinder prints at the end of a `--profile` run:
 *
 *       62.4s  resolve:bulk
 *      262.0s  (wall clock since start)
 *       4248  http:registry.npmjs.org
 *
 * A phase can appear more than once (one line per start), so phases are summed.
 */

export interface Profile {
    phases: Record<string, number>
    counters: Record<string, number>
}

const ANSI = /\x1b\[[0-9;]*m/g

export function parseProfile(log: string): Profile | null {
    const text = log.replace(ANSI, '')
    const at = text.lastIndexOf('Profile:')
    if (at < 0) return null
    const phases: Record<string, number> = {}
    const counters: Record<string, number> = {}
    for (const line of text.slice(at).split('\n').slice(1)) {
        let m = line.match(/^\s+([\d.]+)s\s+(.+?)\s*$/)
        if (m) {
            phases[m[2]] = (phases[m[2]] ?? 0) + Number(m[1])
            continue
        }
        m = line.match(/^\s+(\d+)\s+(\S+)\s*$/)
        if (m) counters[m[2]] = Number(m[1])
    }
    return {phases, counters}
}

/** The numbers summary.md and compare.ts show for one run; everything else stays in results.jsonl. */
export interface Picks {
    wall: number
    profileWall: number | null
    bulk: number | null
    vulnServer: number | null
    enrichMax: number
    blackduck: number
    resolved: number
    refreshing: number
    notFound: number
    pending: number
    error: number
    asked: number
    cacheHit: number
    cacheMiss: number
    registryFetch: number
    registryFetchBy: Record<string, number>
    registryError: number
    http: Record<string, number>
}

function prefixed(record: Record<string, number>, prefix: string): Record<string, number> {
    return Object.fromEntries(Object.entries(record)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), v]))
}

export function pick(profile: Profile | null, wall: number): Picks {
    const p = profile?.phases ?? {}
    const c = profile?.counters ?? {}
    const n = (k: string) => c[k] ?? 0
    const enrich = Object.values(prefixed(p, 'enrich:'))
    const blackduck = Object.values(prefixed(p, 'blackduck:'))
    const resolved = n('resolver:resolved'), refreshing = n('resolver:refreshing'), notFound = n('resolver:not-found')
    const pending = n('resolver:pending'), error = n('resolver:error')
    return {
        wall,
        profileWall: p['(wall clock since start)'] ?? null,
        bulk: p['resolve:bulk'] ?? null,
        vulnServer: p['vuln:server'] ?? null,
        enrichMax: enrich.length ? Math.max(...enrich) : 0,
        blackduck: blackduck.reduce((a, b) => a + b, 0),
        resolved, refreshing, notFound, pending, error,
        // Every purl depinder sent lands in exactly one of the five answers.
        asked: resolved + refreshing + notFound + pending + error,
        cacheHit: n('cache:hit'),
        cacheMiss: n('cache:miss'),
        registryFetch: n('registry:fetch'),
        registryFetchBy: prefixed(c, 'registry:fetch:'),
        registryError: n('registry:error'),
        http: prefixed(c, 'http:'),
    }
}

/** depinder counts registry lookups per plugin ecosystem; the server groups by purl type. */
export const ECOSYSTEM_TO_TYPE: Readonly<Record<string, string>> = {
    npm: 'npm', java: 'maven', go: 'golang', ruby: 'gem', python: 'pypi', php: 'composer', dotnet: 'nuget', rust: 'cargo',
}

export function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
