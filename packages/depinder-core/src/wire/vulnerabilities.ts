import type {Vulnerability} from '../vuln/vulnerability.js'

/**
 * `POST /vulnerabilities`: the request body, its default limit and the JSON answer, as the server
 * sends it and the CLI reads it. See the server's docs/vuln-server.md.
 */

/** The server's default `VULN_MAX_PURLS`: more distinct purls in one request is a 413. */
export const VULN_DEFAULT_MAX_PURLS = 5000

export interface VulnRequestBody {
    purls: string[]
}

/** Why a purl was not scanned. */
export type VulnUnsupportedReason = 'invalid' | 'no_version' | 'unsupported_type'

/** One scanner database build an answer came from. */
export interface VulnDatabaseBuild {
    /** When the database was built upstream. */
    built_at: string
    /** Trivy's schema `Version` (`2`), Grype's `schemaVersion` (`v6.1.9`). */
    schema: string
    age_seconds: number
    /** Older than the server's stale age for that tool. */
    stale: boolean
}

export interface VulnResponse {
    /** Findings per purl, exactly as sent; only vulnerable purls are present. */
    vulnerabilities: Record<string, Vulnerability[]>
    /** The purls that were not scanned, and why. */
    unsupported: {purl: string, reason: VulnUnsupportedReason}[]
    databases: {trivy: VulnDatabaseBuild, grype: VulnDatabaseBuild}
    /** Scanner versions. */
    scanners: {trivy: string, grype: string}
}
