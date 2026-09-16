import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    createExportBlackduckCommand,
    defaultProjectName,
    ExportBlackduckOptions,
    purlTypesIn,
} from '../src/commands/exportBlackduck'
import {sbomPluginsForPurlTypes} from '../src/plugins/sbom'

/**
 * `export-blackduck` is a thin command over `runAnalysis` plus the Black Duck writer, so what is
 * worth testing here is the part that is genuinely its own: the option surface, and the plugin
 * selection that saves the user from having to name `sbom-*` plugins themselves.
 */

interface ParsedInvocation {
    folders: string[]
    options: ExportBlackduckOptions
}

async function parseArgs(...args: string[]): Promise<ParsedInvocation> {
    let parsed: ParsedInvocation | undefined
    const command = createExportBlackduckCommand()
        .action((folders: string[], options: ExportBlackduckOptions) => {
            parsed = {folders, options}
        })
    await command.parseAsync(args, {from: 'user'})
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return parsed!
}

describe('the export-blackduck command line', () => {
    it('takes one or more SBOM folders and a results folder', async () => {
        const {folders, options} = await parseArgs('/sboms', '/more', '-r', 'out')
        expect(folders).toEqual(['/sboms', '/more'])
        expect(options.results).toBe('out')
    })

    it('defaults --vuln-source to what analyse defaults to', async () => {
        expect((await parseArgs('/sboms')).options.vulnSource).toBe('trivy,grype')
        expect((await parseArgs('/sboms', '--vuln-source', 'trivy,grype,github')).options.vulnSource)
            .toBe('trivy,grype,github')
    })

    it('accepts a project name and a token file', async () => {
        const {options} = await parseArgs('/sboms', '--project-name', 'mastodon', '--github-token-file', 'f')
        expect(options.projectName).toBe('mastodon')
        expect(options.githubTokenFile).toBe('f')
    })

    // The options are handed straight to `runAnalysis`, so the resolver flags have to be declared
    // here too or this command could never use a resolver a plain `analyse` run would.
    it('carries the bulk resolver flags that runAnalysis reads', async () => {
        const {options} = await parseArgs('/sboms', '--resolver-url', 'https://resolver.example')
        expect(options.resolverUrl).toBe('https://resolver.example')
        expect(options.resolver).toBe(true)
        expect((await parseArgs('/sboms', '--no-resolver')).options.resolver).toBe(false)
    })
})

describe('choosing plugins from the SBOMs themselves', () => {
    const write = (components: unknown[]): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-select-'))
        const file = path.join(dir, 'demo.cdx.json')
        fs.writeFileSync(file, JSON.stringify({components}))
        return file
    }

    it('reads the purl types out of the SBOM', () => {
        const file = write([
            {purl: 'pkg:gem/nokogiri@1.13.8'},
            {purl: 'pkg:npm/qs@6.10.2'},
            {purl: 'pkg:golang/golang.org/x/crypto@v0.54.0'},
            {'bom-ref': 'no-purl'},
        ])
        expect([...purlTypesIn([file])].sort()).toEqual(['gem', 'golang', 'npm'])
    })

    it('selects exactly the sbom plugins those ecosystems need', () => {
        expect(sbomPluginsForPurlTypes(['gem', 'npm', 'golang']).map(it => it.name).sort())
            .toEqual(['sbom-go', 'sbom-npm', 'sbom-ruby'])
        // A purl type no sbom-* plugin covers selects nothing rather than failing the run.
        expect(sbomPluginsForPurlTypes(['hex'])).toEqual([])
        expect(sbomPluginsForPurlTypes([])).toEqual([])
    })

    it('survives an unreadable SBOM instead of aborting the run', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-select-'))
        const file = path.join(dir, 'broken.cdx.json')
        fs.writeFileSync(file, '{ not json')
        expect(purlTypesIn([file]).size).toBe(0)
    })
})

describe('the default project name', () => {
    it('is the SBOMs\' shared basename, whichever producer wrote them', () => {
        expect(defaultProjectName(
            ['/x/ruby-mastodon.cdx.json', '/x/ruby-mastodon.trivy.cdx.json'], ['/x'])).toBe('ruby-mastodon')
    })

    it('falls back to the folder name when a run spans several projects', () => {
        expect(defaultProjectName(['/x/sboms/a.cdx.json', '/x/sboms/b.cdx.json'], ['/x/sboms'])).toBe('sboms')
    })
})
