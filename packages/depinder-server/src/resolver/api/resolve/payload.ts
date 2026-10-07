import {versionPointer, type CompactVersion, type PackageRecord} from '@depinder/core'
import type {ResolvePackageRow} from '../../db/rows.js'

/** A stored package as the wire carries it. Core's `toPackageRecord` is the same for a fresh fetch. */
export function toPackagePayload(row: ResolvePackageRow, versions: CompactVersion[]): PackageRecord {
    return {
        type: row.type,
        namespace: row.namespace,
        name: row.name,
        description: row.description,
        homepage_url: row.homepage_url,
        repo_url: row.repo_url,
        licenses: row.licenses ?? [],
        latest: versionPointer(row.latest_version, versions),
        latest_prerelease: versionPointer(row.latest_prerelease_version, versions),
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
