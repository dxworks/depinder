import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {CANARIES, type Canary} from '../../src/vuln/canaries.js'
import type {GrypeReport, TrivyReport} from '../../src/vuln/merge/index.js'
import {countGrype, countTrivy, judgeSmoke, SmokeError, smokeTest} from '../../src/vuln/smoke.js'

/**
 * The smoke test's rules against reports shaped like the scanners' own (`c<i>` refs, as the
 * canaries' SBOM writes them), and once end to end with stub scanners printing such a report.
 */

const CANS: Canary[] = [
    {purl: 'pkg:npm/lodash.template@3.6.2', must: 'CVE-2021-23337'},
    {purl: 'pkg:pypi/redis@4.5.1', must: 'CVE-2023-28858'},
]

function trivy(findings: [ref: string, id: string, vendor?: string[]][]): TrivyReport {
    return {Results: [{Vulnerabilities: findings.map(([ref, id, vendor]) => ({VulnerabilityID: id, VendorIDs: vendor, PkgIdentifier: {BOMRef: ref}}))}]}
}

function grype(findings: [ref: string, id: string, related?: string[]][]): GrypeReport {
    return {matches: findings.map(([ref, id, related]) => ({
        vulnerability: {id},
        relatedVulnerabilities: (related ?? []).map(r => ({id: r})),
        artifact: {id: ref},
    }))}
}

describe('counting', () => {
    it('counts every Trivy finding and finds the must ids by ref, also among the vendor ids', () => {
        const report = trivy([['c0', 'CVE-2021-23337'], ['c0', 'CVE-2019-10744'], ['c1', 'GHSA-24wv-mv5m-xv4h', ['CVE-2023-28858']]])
        expect(countTrivy(report, CANS)).toEqual({findings: 3, missing: []})
    })

    it('counts every Grype match and finds the must ids by ref, also among the related ids', () => {
        const report = grype([['c0', 'GHSA-35jh-r3h4-6jhm', ['CVE-2021-23337']], ['c1', 'CVE-2023-28858']])
        expect(countGrype(report, CANS)).toEqual({findings: 2, missing: []})
    })

    it('names a canary whose id was found on another package as missing', () => {
        // The id is there, on the wrong ref: lodash's CVE reported for redis does not count.
        const report = trivy([['c1', 'CVE-2021-23337'], ['c1', 'CVE-2023-28858']])
        expect(countTrivy(report, CANS).missing).toEqual([CANS[0]])
        expect(countGrype({matches: []}, CANS)).toEqual({findings: 0, missing: CANS})
        expect(countTrivy({}, CANS).findings).toBe(0)
    })
})

describe('judgeSmoke', () => {
    it('passes with every must id and at least 90 % of the baseline', () => {
        expect(() => judgeSmoke('trivy', {findings: 144, missing: []}, 160)).not.toThrow()
        expect(() => judgeSmoke('trivy', {findings: 200, missing: []}, 160)).not.toThrow()
        expect(() => judgeSmoke('grype', {findings: 1, missing: []}, null)).not.toThrow()
    })

    it('fails on a missing id, and on a drop of more than 10 %', () => {
        expect(() => judgeSmoke('grype', {findings: 160, missing: [CANS[1]!]}, 160))
            .toThrow(new SmokeError('smoke test: grype missed 1 canary id(s): CVE-2023-28858 on pkg:pypi/redis@4.5.1'))
        expect(() => judgeSmoke('trivy', {findings: 143, missing: []}, 160))
            .toThrow('smoke test: trivy found 143 on the canaries, the current build 160; below 90 %')
    })
})

describe('the canary list', () => {
    it('is purls each tool can scan, across six ecosystems, with one id each', () => {
        expect(CANARIES.length).toBeGreaterThanOrEqual(20)
        expect(new Set(CANARIES.map(c => c.purl)).size).toBe(CANARIES.length)
        expect(new Set(CANARIES.map(c => c.purl.split('/')[0]))).toEqual(new Set([
            'pkg:npm', 'pkg:maven', 'pkg:nuget', 'pkg:composer', 'pkg:golang', 'pkg:pypi',
        ]))
        for (const c of CANARIES) expect(c.must).toMatch(/^(CVE|GHSA)-/)
    })
})

describe('smokeTest', () => {
    let root: string
    let trivyBin: string
    let grypeBin: string

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'vuln-smoke-test-'))
        // A Trivy that finds lodash's CVE and redis's, and a Grype that misses redis's.
        await writeFile(join(root, 'trivy.json'), JSON.stringify(trivy([['c0', 'CVE-2021-23337'], ['c1', 'CVE-2023-28858'], ['c1', 'CVE-2025-1']])))
        await writeFile(join(root, 'grype.json'), JSON.stringify(grype([['c0', 'CVE-2021-23337']])))
        trivyBin = join(root, 'trivy')
        grypeBin = join(root, 'grype')
        await writeFile(trivyBin, `#!/bin/sh\necho "$@" > '${root}/trivy.args'\ncat '${root}/trivy.json'\n`, {mode: 0o755})
        await writeFile(grypeBin, `#!/bin/sh\necho "$GRYPE_DB_CACHE_DIR $@" > '${root}/grype.args'\ncat '${root}/grype.json'\n`, {mode: 0o755})
    })

    afterAll(async () => {
        await rm(root, {recursive: true, force: true})
    })

    const config = () => ({trivyBin, grypeBin, scanTimeoutMs: 5000, tmpDir: root})

    it('scans the canaries with the tool\'s Phase 1 command against the new build and returns the findings', async () => {
        expect(await smokeTest('trivy', '/data/trivy/new', config(), 3, undefined, CANS)).toBe(3)
        const args = (await readFile(join(root, 'trivy.args'), 'utf8')).trim()
        expect(args).toMatch(new RegExp(`^sbom --quiet --format json --skip-db-update --cache-dir /data/trivy/new ${root}/depinder-vuln-[^/]+/sbom.json$`))
        // The SBOM folder is gone.
        expect((await readdir(root)).filter(name => name.startsWith('depinder-vuln-'))).toEqual([])
    })

    it('fails the build that misses a must id, or falls 10 % short of the baseline', async () => {
        await expect(smokeTest('grype', '/data/grype/new', config(), null, undefined, CANS)).rejects.toThrow(/grype missed 1 canary id\(s\): CVE-2023-28858/)
        expect((await readFile(join(root, 'grype.args'), 'utf8')).trim()).toMatch(/^\/data\/grype\/new -q sbom:/)
        await expect(smokeTest('trivy', '/data/trivy/new', config(), 4, undefined, CANS)).rejects.toThrow(/found 3 on the canaries, the current build 4/)
    })

    it('fails on a scanner that does not run', async () => {
        await expect(smokeTest('trivy', '/x', {...config(), trivyBin: join(root, 'missing')}, null, undefined, CANS))
            .rejects.toThrow(/^smoke test: trivy spawn failed: .*ENOENT/)
    })
})
