import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gzipSync} from 'node:zlib'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
    assetUrl,
    compareVersions,
    downloadFile,
    expectedSha256,
    extractFile,
    fetchReleases,
    type GithubRelease,
    releaseCutoff,
    releaseFiles,
    selectRelease,
} from '../../src/vuln/releases.js'

/** GitHub, the archives and the checksums are all made up here: no network. */

const DAY = 86_400_000
const NOW = Date.parse('2026-11-17T12:00:00Z')

function release(tag: string, ageDays: number, extra: Partial<GithubRelease> = {}): GithubRelease {
    return {tag_name: tag, draft: false, prerelease: false, published_at: new Date(NOW - ageDays * DAY).toISOString(), assets: [], ...extra}
}

const select = (releases: GithubRelease[], current = '0.74.0', rejected: string[] = []) =>
    selectRelease(releases, {current, minAgeMs: 7 * DAY, now: NOW, rejected: v => rejected.includes(v)})

describe('releaseCutoff', () => {
    it('is the minimum age before the last Monday 05:00 UTC', () => {
        expect(releaseCutoff(Date.parse('2026-11-17T12:00:00Z'), 7 * DAY)).toBe(Date.parse('2026-11-09T05:00:00Z'))
        expect(releaseCutoff(Date.parse('2026-11-16T05:00:00Z'), 7 * DAY)).toBe(Date.parse('2026-11-09T05:00:00Z'))
        expect(releaseCutoff(Date.parse('2026-11-16T04:59:59Z'), 7 * DAY)).toBe(Date.parse('2026-11-02T05:00:00Z'))
    })
})

describe('selectRelease', () => {
    it('takes the newest stable release past the cooldown, and reports the newest of any age', () => {
        const picked = select([release('v0.76.2', 12), release('v0.75.0', 47), release('v0.77.0', 1), release('v0.76.10', 9)])
        expect(picked.candidate?.version).toBe('0.76.10')
        expect(picked.candidate?.tag).toBe('v0.76.10')
        expect(picked.latest).toBe('0.77.0')
    })

    it('skips drafts, prereleases and tags that are not a plain x.y.z', () => {
        const picked = select([
            release('v0.80.0', 30, {draft: true, published_at: null}),
            release('v0.79.0', 30, {prerelease: true}),
            release('v0.78.0-rc1', 30),
            release('nightly', 30),
            release('v0.75.0', 30),
        ])
        expect(picked).toMatchObject({candidate: {version: '0.75.0'}, latest: '0.75.0'})
    })

    it('waits out the cooldown, counted from the last Monday 05:00 UTC like the CI bump bots', () => {
        // NOW is Tue 2026-11-17 12:00; the last Monday run was 2026-11-16 05:00, so the cutoff is 2026-11-09 05:00
        const at = (iso: string): GithubRelease => ({...release('v0.75.0', 0), published_at: iso})
        expect(select([at('2026-11-09T05:00:00Z')]).candidate?.version).toBe('0.75.0')
        expect(select([at('2026-11-09T05:00:01Z')]).candidate).toBeUndefined()
        expect(select([at('2026-11-09T12:00:00Z')]).candidate).toBeUndefined() // 8 days old, waits for next Monday
    })

    it('takes nothing that is not newer than ours, and nothing refused, falling back to the next one', () => {
        expect(select([release('v0.74.0', 90), release('v0.73.9', 99)]).candidate).toBeUndefined()
        expect(select([release('v0.76.0', 20), release('v0.75.0', 40)], '0.74.0', ['0.76.0']).candidate?.version).toBe('0.75.0')
        expect(select([release('v0.76.0', 20)], '0.74.0', ['0.76.0'])).toEqual({candidate: undefined, latest: '0.76.0'})
    })

    it('reads Grype\'s tags the same way', () => {
        expect(select([release('v0.122.0', 30), release('v0.121.3', 30)], '0.118.0').candidate?.version).toBe('0.122.0')
    })

    it('compares versions numerically, not as text', () => {
        expect(compareVersions('0.118.0', '0.99.9')).toBeGreaterThan(0)
        expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
        expect(compareVersions('garbage', '0.0.1')).toBeLessThan(0)
    })
})

describe('releaseFiles and assetUrl', () => {
    it('names each publisher\'s Linux archive for the CPU, its checksums and the bundle', () => {
        expect(releaseFiles('trivy', '0.76.2', 'x64')).toEqual({
            archive: 'trivy_0.76.2_Linux-64bit.tar.gz',
            checksums: 'trivy_0.76.2_checksums.txt',
            bundle: 'trivy_0.76.2_checksums.txt.sigstore.json',
        })
        expect(releaseFiles('trivy', '0.76.2', 'arm64').archive).toBe('trivy_0.76.2_Linux-ARM64.tar.gz')
        expect(releaseFiles('grype', '0.122.0', 'x64').archive).toBe('grype_0.122.0_linux_amd64.tar.gz')
        expect(releaseFiles('grype', '0.122.0', 'arm64').archive).toBe('grype_0.122.0_linux_arm64.tar.gz')
        expect(() => releaseFiles('grype', '0.122.0', 'ia32')).toThrow(/no grype release for CPU ia32/)
    })

    it('builds the download URL itself', () => {
        expect(assetUrl('grype', 'v0.122.0', 'grype_0.122.0_checksums.txt'))
            .toBe('https://github.com/anchore/grype/releases/download/v0.122.0/grype_0.122.0_checksums.txt')
    })
})

describe('expectedSha256', () => {
    const sum = 'a'.repeat(64)
    const other = 'B'.repeat(64)
    const file = `${sum}  trivy_0.76.2_Linux-64bit.tar.gz\n${other}  trivy_0.76.2_Linux-ARM64.tar.gz\n`

    it('finds the entry for the archive, lower-cased', () => {
        expect(expectedSha256(file, 'trivy_0.76.2_Linux-64bit.tar.gz')).toBe(sum)
        expect(expectedSha256(file, 'trivy_0.76.2_Linux-ARM64.tar.gz')).toBe('b'.repeat(64))
        expect(expectedSha256(`${sum} *x.tar.gz\n`, 'x.tar.gz')).toBe(sum)
    })

    it('fails closed on a missing entry, a near miss, or two different sums', () => {
        expect(() => expectedSha256(file, 'trivy_0.76.2_Linux-32bit.tar.gz')).toThrow(/no entry for trivy_0.76.2_Linux-32bit/)
        expect(() => expectedSha256(file, 'Linux-64bit.tar.gz')).toThrow(/no entry/)
        expect(() => expectedSha256(`${'a'.repeat(63)}  x.tar.gz\n`, 'x.tar.gz')).toThrow(/no entry/)
        expect(() => expectedSha256(`${sum}  x.tar.gz\n${'c'.repeat(64)}  x.tar.gz\n`, 'x.tar.gz')).toThrow(/2 different sums/)
    })

    it('reads the real Trivy 0.74.0 checksums file', async () => {
        const real = await readFile(new URL('../fixtures/scanner-releases/trivy_0.74.0_checksums.txt', import.meta.url), 'utf8')
        expect(expectedSha256(real, 'trivy_0.74.0_Linux-64bit.tar.gz')).toMatch(/^[0-9a-f]{64}$/)
    })
})

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vuln-releases-test-'))
})

afterEach(async () => {
    await rm(dir, {recursive: true, force: true})
})

/** One ustar entry: a header with a valid checksum, the data, padded to 512. */
function entry(name: string, data: Buffer | string, type = '0'): Buffer {
    const body = Buffer.from(data)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write('0000755\0', 100)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write(type, 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.fill(' ', 148, 156)
    let sum = 0
    for (const b of header) sum += b
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)])
}

const tarGz = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))

async function archive(...entries: Buffer[]): Promise<string> {
    const path = join(dir, `a-${Math.random()}.tar.gz`)
    await writeFile(path, tarGz(...entries))
    return path
}

describe('extractFile', () => {
    const binary = Buffer.alloc(70_000, 7)

    it('writes the one binary, executable by its owner, and nothing else', async () => {
        const path = await archive(entry('LICENSE', 'text'), entry('contrib/html.tpl', 'x'), entry('trivy', binary), entry('README.md', 'y'))
        await extractFile(path, 'trivy', join(dir, 'out'), 1e6)
        expect(await readFile(join(dir, 'out'))).toEqual(binary)
        expect((await stat(join(dir, 'out'))).mode & 0o777).toBe(0o700)
    })

    it('accepts ./trivy, and skips a link or folder of the same name', async () => {
        const path = await archive(entry('trivy', '', '2'), entry('./trivy', binary))
        await extractFile(path, 'trivy', join(dir, 'out'), 1e6)
        expect(await readFile(join(dir, 'out'))).toEqual(binary)
    })

    const small = Buffer.alloc(100, 7)
    const refusals: [string, () => Promise<string>, RegExp][] = [
        ['the binary is missing', () => archive(entry('grype', small)), /trivy is not in the archive/],
        ['the binary is in a folder', () => archive(entry('bin/trivy', small)), /not in the archive/],
        ['the binary is there twice', () => archive(entry('trivy', small), entry('trivy', 'evil')), /in the archive twice/],
        ['the binary is too large', () => archive(entry('trivy', Buffer.alloc(2000))), /over 1000 bytes/],
        ['the archive unpacks to far more than any binary', () => archive(entry('padding', Buffer.alloc(5000)), entry('trivy', small)),
            /unpacks to more than 4000 bytes/],
        ['the archive is cut short', async () => {
            const path = join(dir, 'cut.tar.gz')
            await writeFile(path, gzipSync(entry('trivy', Buffer.alloc(900)).subarray(0, 800)))
            return path
        }, /cut short/],
        ['a header is corrupt', async () => {
            const bad = entry('trivy', 'x')
            bad[0] = 0x41
            return archive(bad)
        }, /corrupt tar header/],
    ]
    for (const [name, make, error] of refusals) {
        it(`refuses when ${name}`, async () => {
            await expect(extractFile(await make(), 'trivy', join(dir, 'out'), 1000)).rejects.toThrow(error)
        })
    }

    it('never overwrites a file that is already there', async () => {
        await writeFile(join(dir, 'out'), 'keep')
        await expect(extractFile(await archive(entry('trivy', binary)), 'trivy', join(dir, 'out'), 1e6)).rejects.toThrow(/EEXIST/)
        expect(await readFile(join(dir, 'out'), 'utf8')).toBe('keep')
    })
})

function fakeFetch(status: number, body: string | Buffer, headers: Record<string, string> = {}): typeof fetch {
    return (async () => new Response(status === 204 ? null : new Uint8Array(Buffer.from(body)), {status, headers})) as typeof fetch
}

describe('downloadFile', () => {
    it('writes the body and returns its sha256', async () => {
        const body = Buffer.alloc(100_000, 3)
        const sum = await downloadFile('https://x/a', join(dir, 'a'), 1e6, {fetch: fakeFetch(200, body)})
        expect(sum).toBe(createHash('sha256').update(body).digest('hex'))
        expect(await readFile(join(dir, 'a'))).toEqual(body)
    })

    it('refuses more than the limit, by header or by count, and an HTTP error', async () => {
        await expect(downloadFile('https://x/a', join(dir, 'a'), 10, {fetch: fakeFetch(200, 'x'.repeat(11), {'content-length': '11'})}))
            .rejects.toThrow(/over 10 bytes/)
        await expect(downloadFile('https://x/b', join(dir, 'b'), 10, {fetch: fakeFetch(200, 'x'.repeat(11))})).rejects.toThrow(/over 10 bytes/)
        await expect(downloadFile('https://x/c', join(dir, 'c'), 10, {fetch: fakeFetch(404, 'nope')})).rejects.toThrow(/HTTP 404/)
    })
})

describe('fetchReleases', () => {
    it('reads the list and refuses anything that is not one', async () => {
        const list = [release('v0.76.2', 12, {assets: [{name: 'trivy_0.76.2_checksums.txt'}]})]
        await expect(fetchReleases('trivy', {fetch: fakeFetch(200, JSON.stringify(list))})).resolves.toEqual(list)
        await expect(fetchReleases('trivy', {fetch: fakeFetch(200, '{"message": "rate limited"}')})).rejects.toThrow(/not a list of releases/)
        await expect(fetchReleases('trivy', {fetch: fakeFetch(403, '{}')})).rejects.toThrow(/HTTP 403 from https:\/\/api.github.com\/repos\/aquasecurity\/trivy/)
    })
})
