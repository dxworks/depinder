import type {CompactVersion, ResolvePackageRow} from '../../db/rows.js'
import type {PackagePayload} from './types.js'

export function toPackagePayload(row: ResolvePackageRow, versions: CompactVersion[]): PackagePayload {
    const releasedAt = (version: string | null): string | null =>
        version ? isoFromEpoch(versions.find(v => v[0] === version)?.[1] ?? null) : null

    return {
        type: row.type,
        namespace: row.namespace,
        name: row.name,
        description: row.description,
        homepage_url: row.homepage_url,
        repo_url: row.repo_url,
        licenses: row.licenses ?? [],
        latest: row.latest_version ? {version: row.latest_version, released_at: releasedAt(row.latest_version)} : null,
        latest_prerelease: row.latest_prerelease_version
            ? {
                  version: row.latest_prerelease_version,
                  released_at: releasedAt(row.latest_prerelease_version),
              }
            : null,
        // Straight through: Postgres built these, and nothing here touches them again.
        versions,
        as_of: iso(row.as_of),
        source: row.source,
        fetched_at: iso(row.fetched_at),
        confirmed_at: iso(row.confirmed_at),
    }
}

export function time(date: Date | null): number {
    return date ? date.getTime() : -Infinity
}

export function iso(date: Date | null | undefined): string | null {
    return date ? date.toISOString() : null
}

/** Epoch seconds back to the ISO string the package-level fields still carry. */
function isoFromEpoch(seconds: number | null | undefined): string | null {
    return seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString()
}
