import fs from 'fs'
import os from 'os'
import path from 'path'
import {depMinerManifests, findDepMinerIndex, readDepMinerIndex} from '../src/blackduck/depminer-index'
import {SbomDescription} from '../src/plugins/sbom/describe'

/** DepMiner's results as `analyse` meets them: `results/{syft,trivy}/*.cdx.json` beside `results/depminer/`. */

let results: string

beforeEach(() => {
    results = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-depminer-index-'))
    write('depminer/package-0.json', {name: 'n8n-monorepo', version: '2.37.0'})
    write('depminer/package-1.json', {name: 'docs', version: '0.0.0'})
    write('depminer/pnpm-lock.yaml', '')
    write('depminer/index.json', {
        'package-0.json': 'js-pnpm-n8n/package.json',
        'package-1.json': 'js-pnpm-n8n/docs/package.json',
        'pnpm-lock.yaml': 'js-pnpm-n8n/pnpm-lock.yaml',
    })
    write('syft/js-pnpm-n8n.syft.cdx.json', {})
})

afterEach(() => {
    fs.rmSync(results, {recursive: true, force: true})
})

function write(relative: string, content: string | object): void {
    const file = path.join(results, relative)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

function sbom(repo: string): SbomDescription {
    return {file: path.join(results, 'syft', `${repo}.syft.cdx.json`), producer: 'syft', repo, repoFromMetadata: true, purlTypes: new Set(['npm'])}
}

describe('readDepMinerIndex', () => {
    it('groups the flat copies by repository, keyed by their path inside it', () => {
        const repos = readDepMinerIndex(path.join(results, 'depminer', 'index.json'))
        expect([...repos.keys()]).toEqual(['js-pnpm-n8n'])
        expect([...repos.get('js-pnpm-n8n') ?? []]).toEqual([
            ['package.json', path.join(results, 'depminer', 'package-0.json')],
            ['docs/package.json', path.join(results, 'depminer', 'package-1.json')],
            ['pnpm-lock.yaml', path.join(results, 'depminer', 'pnpm-lock.yaml')],
        ])
    })
})

describe('findDepMinerIndex', () => {
    const indexFile = () => path.join(results, 'depminer', 'index.json')

    it('finds the index beside the input, whether the input is the results folder or one source in it', () => {
        expect(findDepMinerIndex(sbom('x').file, results)).toBe(indexFile())
        expect(findDepMinerIndex(sbom('x').file, path.join(results, 'syft'))).toBe(indexFile())
    })

    it('looks no higher than the folder holding the input', () => {
        write('nested/deeper/syft/a.cdx.json', {})
        expect(findDepMinerIndex(path.join(results, 'nested/deeper/syft/a.cdx.json'), path.join(results, 'nested/deeper/syft'))).toBeUndefined()
    })
})

describe('depMinerManifests', () => {
    it('reads the SBOM repository\'s manifests from the index found beside the input', () => {
        const manifests = depMinerManifests(undefined, results)(sbom('js-pnpm-n8n'))
        expect(manifests?.manifests.map(m => [m.dir, m.name, m.version])).toEqual([
            ['', 'n8n-monorepo', '2.37.0'],
            ['docs', 'docs', '0.0.0'],
        ])
        expect([...manifests?.lockDirs ?? []]).toEqual(['npm\0'])
    })

    it('takes an index given by file or by folder, from anywhere', () => {
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-no-index-'))
        try {
            const byFile = depMinerManifests(path.join(results, 'depminer', 'index.json'), elsewhere)
            const byFolder = depMinerManifests(path.join(results, 'depminer'), elsewhere)
            const away = {...sbom('js-pnpm-n8n'), file: path.join(elsewhere, 'js-pnpm-n8n.cdx.json')}
            expect(byFile(away)?.manifests).toHaveLength(2)
            expect(byFolder(away)?.manifests).toHaveLength(2)
            expect(depMinerManifests(undefined, elsewhere)(away)).toBeUndefined()
        } finally {
            fs.rmSync(elsewhere, {recursive: true, force: true})
        }
    })

    it('reads nothing when turned off, for a repository the index does not list, or for an unreadable index', () => {
        expect(depMinerManifests(false, results)(sbom('js-pnpm-n8n'))).toBeUndefined()
        expect(depMinerManifests(undefined, results)(sbom('rust-ripgrep'))).toBeUndefined()
        expect(depMinerManifests(path.join(results, 'missing.json'), results)(sbom('js-pnpm-n8n'))).toBeUndefined()
    })
})
