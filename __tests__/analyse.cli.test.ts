import {AnalyseOptions, createAnalyseCommand} from '../src/commands/analyse'

/**
 * The option declarations used to omit the `<value>` placeholder, which makes Commander register
 * them as booleans: `-r out` parsed to `{R: true}` and `out` was swallowed into the folders
 * argument (then walked, and usually failing with ENOENT), while `--plugins` never reached
 * `getPluginsFromNames` — so results always landed in ./results and all twelve plugins always ran.
 */

interface ParsedInvocation {
    folders: string[]
    options: AnalyseOptions
}

async function parseArgs(...args: string[]): Promise<ParsedInvocation> {
    let parsed: ParsedInvocation | undefined
    // A fresh command per parse (Commander keeps option values on the instance), with the
    // analyseFiles handler replaced so parsing does not run an analysis.
    const command = createAnalyseCommand().action((folders: string[], options: AnalyseOptions) => {
        parsed = {folders, options}
    })
    await command.parseAsync(args, {from: 'user'})
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return parsed!
}

describe('the analyse command line', () => {
    it('reads the results folder from -r and leaves it out of the folders', async () => {
        const {folders, options} = await parseArgs('/repo', '-r', 'out')
        expect(options.results).toBe('out')
        expect(folders).toEqual(['/repo'])
    })

    it('reads the results folder from --results', async () => {
        expect((await parseArgs('/repo', '--results', 'out')).options.results).toBe('out')
    })

    it('defaults the results folder to results', async () => {
        expect((await parseArgs('/repo')).options.results).toBe('results')
    })

    it('collects a variadic plugin list', async () => {
        const {folders, options} = await parseArgs('/repo', '--plugins', 'java', 'sbom-java')
        expect(options.plugins).toEqual(['java', 'sbom-java'])
        expect(folders).toEqual(['/repo'])
    })

    it('accepts -p for the plugin list', async () => {
        expect((await parseArgs('/repo', '-p', 'sbom-npm')).options.plugins).toEqual(['sbom-npm'])
    })

    it('leaves plugins undefined when not given, so every plugin runs', async () => {
        expect((await parseArgs('/repo')).options.plugins).toBeUndefined()
    })

    it('still parses --refresh as a boolean', async () => {
        expect((await parseArgs('/repo', '--refresh')).options.refresh).toBe(true)
        expect((await parseArgs('/repo')).options.refresh).toBe(false)
    })

    it('accepts both value options together with several folders', async () => {
        const {folders, options} = await parseArgs('/a', '/b', '-r', 'out', '-p', 'java')
        expect(folders).toEqual(['/a', '/b'])
        expect(options.results).toBe('out')
        expect(options.plugins).toEqual(['java'])
    })
})
