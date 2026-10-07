/**
 * Helpers every registry file needs, so the eight of them agree on what a license, a date and a
 * repository URL look like.
 */

/**
 * Registries spell licenses half a dozen ways: `"MIT"`, `{type: "MIT", url: "..."}`, an array of
 * either (npm's legacy `licenses[]`), an SPDX expression, or nothing. This flattens all of it to
 * a deduplicated list of strings and leaves SPDX expressions (`"MIT OR Apache-2.0"`) intact,
 * because splitting them would claim a package is under a license it may not be under.
 */
export function normaliseLicenses(input: unknown): string[] {
    const out: string[] = []
    collectLicenses(input, out, 0)
    return unique(out)
}

function collectLicenses(input: unknown, out: string[], depth: number): void {
    if (input == null || depth > 3) return
    if (typeof input === 'string') {
        const trimmed = input.trim()
        if (trimmed) out.push(trimmed)
        return
    }
    if (Array.isArray(input)) {
        for (const item of input) collectLicenses(item, out, depth + 1)
        return
    }
    if (typeof input === 'object') {
        const record = input as Record<string, unknown>
        // `{type, url}` (npm), `{name}` (some mirrors), `{license}` (deps.dev-ish shapes).
        collectLicenses(record.type ?? record.name ?? record.license ?? record.expression, out, depth + 1)
    }
}

/** Parses whatever a registry calls a timestamp. Returns null for missing, unparseable or epoch-0. */
export function toDate(value: unknown): Date | null {
    if (value == null) return null
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null
        // Seconds vs milliseconds: anything below year 2001 in ms is really a seconds stamp.
        const ms = value < 1e11 ? value * 1000 : value
        const date = new Date(ms)
        return Number.isNaN(date.getTime()) ? null : date
    }
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return null
        const date = new Date(trimmed)
        if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return null
        return date
    }
    return null
}

/**
 * Turns the many spellings of a repository into a browsable https URL:
 * `git+https://github.com/x/y.git`, `git://github.com/x/y`, `git@github.com:x/y.git`,
 * `github:x/y`.
 */
export function normaliseRepoUrl(value: unknown): string | undefined {
    let url = typeof value === 'string' ? value.trim() : undefined
    if (!url && value && typeof value === 'object') {
        const inner = (value as Record<string, unknown>).url
        url = typeof inner === 'string' ? inner.trim() : undefined
    }
    if (!url) return undefined

    url = url.replace(/^git\+/, '').replace(/^git\+ssh:\/\//, 'ssh://')
    const scp = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(url)
    if (scp) url = `https://${scp[1]}/${scp[2]}`
    else if (url.startsWith('git://')) url = `https://${url.slice('git://'.length)}`
    else if (/^(github|gitlab|bitbucket):/.test(url)) {
        const [host, path] = url.split(':', 2)
        const domain = host === 'github' ? 'github.com' : host === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'
        url = `https://${domain}/${path}`
    }
    url = url.replace(/\.git$/, '')
    return url || undefined
}

/** A plain string field, or undefined when the registry put something else there. */
export function stringOrUndefined(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
}

function unique(values: string[]): string[] {
    return [...new Set(values)]
}
