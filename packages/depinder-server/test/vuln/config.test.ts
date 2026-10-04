import {availableParallelism, tmpdir} from 'node:os'
import {describe, expect, it} from 'vitest'
import {loadConfig} from '../../src/resolver/config.js'
import {ConfigError} from '../../src/shared/config.js'
import {loadVulnConfig} from '../../src/vuln/config.js'

const base = {
    RESOLVER_API_TOKEN: 'test-token-'.padEnd(16, 'x'),
    TRIVY_CACHE_DIR: '/var/lib/trivy',
    GRYPE_DB_CACHE_DIR: '/var/lib/grype',
}

describe('loadVulnConfig', () => {
    it('fills in the defaults, with no DATABASE_URL anywhere', () => {
        const scans = Math.max(1, Math.floor(availableParallelism() / 2))
        expect(loadVulnConfig(base)).toEqual({
            mode: 'frozen',
            apiToken: base.RESOLVER_API_TOKEN,
            port: 8080,
            logLevel: 'info',
            trivyBin: 'trivy',
            grypeBin: 'grype',
            trivyCacheDir: '/var/lib/trivy',
            grypeDbCacheDir: '/var/lib/grype',
            maxPurls: 5000,
            maxScans: scans,
            maxQueued: 4 * scans,
            scanTimeoutMs: 60_000,
            tmpDir: tmpdir(),
            trivyStaleHours: 24,
            grypeStaleHours: 72,
            checkIntervalMin: 30,
            downloadTimeoutMs: 900_000,
            trivyDbRepository: 'mirror.gcr.io/aquasec/trivy-db:2',
            grypeDbUpdateUrl: 'https://grype.anchore.io/databases/v6/latest.json',
        })
    })

    it('reads the optional settings', () => {
        expect(loadVulnConfig({
            ...base,
            PORT: '9001',
            LOG_LEVEL: 'debug',
            TRIVY_BIN: '/opt/trivy',
            GRYPE_BIN: '/opt/grype',
            VULN_MAX_PURLS: '2000',
            VULN_MAX_SCANS: '3',
            VULN_SCAN_TIMEOUT_MS: '5000',
            VULN_TMP_DIR: '/scratch',
            VULN_TRIVY_STALE_HOURS: '12',
            VULN_GRYPE_STALE_HOURS: '48',
        })).toMatchObject({
            port: 9001,
            logLevel: 'debug',
            trivyBin: '/opt/trivy',
            grypeBin: '/opt/grype',
            maxPurls: 2000,
            maxScans: 3,
            // Follows the scans it was not given explicitly.
            maxQueued: 12,
            scanTimeoutMs: 5000,
            tmpDir: '/scratch',
            trivyStaleHours: 12,
            grypeStaleHours: 48,
        })
        expect(loadVulnConfig({...base, VULN_MAX_QUEUED: '0'}).maxQueued).toBe(0)
    })

    it('refuses a missing or short token, with the resolver\'s messages', () => {
        expect(() => loadVulnConfig({...base, RESOLVER_API_TOKEN: undefined})).toThrow(/RESOLVER_API_TOKEN is required/)
        expect(() => loadVulnConfig({...base, RESOLVER_API_TOKEN: 'x'.repeat(15)})).toThrow(/at least 16 characters/)
    })

    it('refuses a missing cache dir', () => {
        expect(() => loadVulnConfig({...base, TRIVY_CACHE_DIR: undefined})).toThrow(/TRIVY_CACHE_DIR is required/)
        expect(() => loadVulnConfig({...base, GRYPE_DB_CACHE_DIR: '  '})).toThrow(/GRYPE_DB_CACHE_DIR is required/)
    })

    it('is managed with VULN_DATA_DIR, frozen with the two cache dirs, and neither or both is an error', () => {
        const managed = {RESOLVER_API_TOKEN: base.RESOLVER_API_TOKEN, VULN_DATA_DIR: '/var/lib/vuln'}
        const config = loadVulnConfig(managed)
        expect(config).toMatchObject({mode: 'managed', dataDir: '/var/lib/vuln'})
        expect(config).not.toHaveProperty('trivyCacheDir')
        expect(config).not.toHaveProperty('grypeDbCacheDir')
        expect(loadVulnConfig(base)).not.toHaveProperty('dataDir')

        expect(() => loadVulnConfig({RESOLVER_API_TOKEN: base.RESOLVER_API_TOKEN})).toThrow(/VULN_DATA_DIR is required/)
        expect(() => loadVulnConfig({...base, VULN_DATA_DIR: '/var/lib/vuln'})).toThrow(/not both/)
        expect(() => loadVulnConfig({...managed, TRIVY_CACHE_DIR: '/var/lib/trivy'})).toThrow(/not both/)
    })

    it('reads the update settings, and gives the Trivy repository its tag', () => {
        expect(loadVulnConfig({
            ...base,
            VULN_DB_CHECK_INTERVAL_MIN: '60',
            VULN_DB_DOWNLOAD_TIMEOUT_MS: '120000',
            TRIVY_DB_REPOSITORY: 'ghcr.io/aquasecurity/trivy-db',
            GRYPE_DB_UPDATE_URL: 'https://mirror.example.com/grype/latest.json',
        })).toMatchObject({
            checkIntervalMin: 60,
            downloadTimeoutMs: 120_000,
            trivyDbRepository: 'ghcr.io/aquasecurity/trivy-db:2',
            grypeDbUpdateUrl: 'https://mirror.example.com/grype/latest.json',
        })
        expect(loadVulnConfig({...base, TRIVY_DB_REPOSITORY: 'registry.local:5000/trivy-db:3'}).trivyDbRepository)
            .toBe('registry.local:5000/trivy-db:3')
        expect(() => loadVulnConfig({...base, TRIVY_DB_REPOSITORY: 'https://ghcr.io/x'})).toThrow(/TRIVY_DB_REPOSITORY/)
        expect(() => loadVulnConfig({...base, TRIVY_DB_REPOSITORY: 'Bad Repo'})).toThrow(/TRIVY_DB_REPOSITORY/)
        expect(() => loadVulnConfig({...base, GRYPE_DB_UPDATE_URL: 'ftp://x/latest.json'})).toThrow(/GRYPE_DB_UPDATE_URL/)
    })

    it('range-checks the numbers', () => {
        const bad: [string, string][] = [
            ['VULN_MAX_PURLS', '0'], ['VULN_MAX_PURLS', '50001'], ['VULN_MAX_PURLS', '1.5'],
            ['VULN_MAX_SCANS', '0'], ['VULN_MAX_SCANS', '65'],
            ['VULN_MAX_QUEUED', '-1'], ['VULN_MAX_QUEUED', '1001'],
            ['VULN_SCAN_TIMEOUT_MS', '999'], ['VULN_SCAN_TIMEOUT_MS', '600001'], ['VULN_SCAN_TIMEOUT_MS', 'soon'],
            ['VULN_TRIVY_STALE_HOURS', '0'], ['VULN_GRYPE_STALE_HOURS', '8761'],
            ['VULN_DB_CHECK_INTERVAL_MIN', '4'], ['VULN_DB_CHECK_INTERVAL_MIN', '1441'],
            ['VULN_DB_DOWNLOAD_TIMEOUT_MS', '59999'], ['VULN_DB_DOWNLOAD_TIMEOUT_MS', '7200001'],
            ['PORT', '0'], ['LOG_LEVEL', 'loud'],
        ]
        for (const [name, value] of bad) {
            expect(() => loadVulnConfig({...base, [name]: value}), `${name}=${value}`).toThrow(ConfigError)
        }
        expect(loadVulnConfig({...base, VULN_MAX_PURLS: '50000', VULN_MAX_SCANS: '64'})).toMatchObject({maxPurls: 50_000, maxScans: 64})
    })
})

describe('loadConfig and ROLE=vuln', () => {
    it('still requires DATABASE_URL for the other roles', () => {
        for (const ROLE of ['resolver-api', 'resolver-worker', 'resolver', 'all']) {
            expect(() => loadConfig({RESOLVER_API_TOKEN: base.RESOLVER_API_TOKEN, ROLE})).toThrow(/DATABASE_URL is required/)
        }
    })

    it('rejects ROLE=vuln, which has a loader of its own', () => {
        expect(() => loadConfig({...base, DATABASE_URL: 'postgresql://localhost/x', ROLE: 'vuln'}))
            .toThrow('ROLE=vuln is loaded by loadVulnConfig')
    })
})
