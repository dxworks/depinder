import {LibraryInfo} from '../extension-points/library-info'
import {Plugin} from '../extension-points/plugin'
import {log} from './logging'
import {getVulnerabilitiesFromGithub} from './vulnerabilities'

/**
 * Adds GitHub's advisories to a freshly fetched library, when the plugin has an advisory ecosystem
 * and GH_TOKEN is set. A failed lookup must not discard the registry data: it leaves none.
 */
export async function attachGithubAdvisories(lib: LibraryInfo, plugin: Plugin): Promise<void> {
    const ecosystem = plugin.checker?.githubSecurityAdvisoryEcosystem
    if (!ecosystem || !process.env.GH_TOKEN) return
    try {
        lib.vulnerabilities = await getVulnerabilitiesFromGithub(ecosystem, lib.name)
    } catch (e: any) {
        log.warn(`Vulnerability lookup failed for ${lib.name}: ${e.message ?? e}`)
    }
}
