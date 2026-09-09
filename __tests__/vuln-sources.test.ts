import {
    DEFAULT_VULN_SOURCE,
    describeVulnSources,
    parseVulnSources,
    resetVulnSources,
    setVulnSources,
    UnknownVulnSourceError,
    vulnSources,
} from '../src/vuln-sources/selection'
import {mergeVulnerabilityIndexes} from '../src/vuln-sources/merge'
import {Vulnerability} from '../src/extension-points/vulnerability-checker'

describe('parseVulnSources', () => {
    afterEach(resetVulnSources)

    it('keeps today\'s behaviour by default', () => {
        expect(parseVulnSources(DEFAULT_VULN_SOURCE)).toEqual({trivy: true, grype: true, github: false})
        expect(vulnSources()).toEqual({trivy: true, grype: true, github: false})
    })

    it('reads one source, several sources, and all', () => {
        expect(parseVulnSources('github')).toEqual({trivy: false, grype: false, github: true})
        expect(parseVulnSources('trivy,github')).toEqual({trivy: true, grype: false, github: true})
        expect(parseVulnSources('all')).toEqual({trivy: true, grype: true, github: true})
        expect(parseVulnSources(' GRYPE , github ')).toEqual({trivy: false, grype: true, github: true})
    })

    it('rejects a name it does not know rather than silently scanning nothing', () => {
        expect(() => parseVulnSources('snyk')).toThrow(UnknownVulnSourceError)
        expect(() => parseVulnSources('')).toThrow(UnknownVulnSourceError)
    })

    it('is readable back for the log line', () => {
        setVulnSources(parseVulnSources('all'))
        expect(describeVulnSources()).toBe('trivy, grype, github')
    })
})

describe('mergeVulnerabilityIndexes', () => {
    const trivyFinding = (): Vulnerability => ({
        severity: 'HIGH',
        description: 'from trivy',
        permalink: 'https://avd.aquasec.com/CVE-2022-24999',
        source: 'trivy',
        identifiers: [{value: 'CVE-2022-24999', type: 'CVE'}, {value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'}],
    })
    const githubFinding = (): Vulnerability => ({
        severity: 'HIGH',
        description: 'from github',
        permalink: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
        source: 'github',
        identifiers: [{value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'}, {value: 'CVE-2022-24999', type: 'CVE'}],
    })

    it('recognises the same finding through an alias, whichever id each source calls primary', () => {
        const base = new Map([['qs@6.10.2', [trivyFinding()]]])
        const merged = mergeVulnerabilityIndexes(base, new Map([['qs@6.10.2', [githubFinding()]]]))
        const findings = merged.get('qs@6.10.2') ?? []
        expect(findings).toHaveLength(1)
        expect(findings[0].description).toBe('from trivy')
        expect(findings[0].source).toBe('trivy,github')
    })

    it('adds a finding only one source knows', () => {
        const onlyGithub: Vulnerability = {
            severity: 'LOW',
            description: 'github only',
            permalink: '',
            source: 'github',
            identifiers: [{value: 'GHSA-only-in-git-hubs', type: 'GHSA'}],
        }
        const base = new Map([['qs@6.10.2', [trivyFinding()]]])
        const merged = mergeVulnerabilityIndexes(base, new Map([['qs@6.10.2', [onlyGithub]]]))
        expect(merged.get('qs@6.10.2')).toHaveLength(2)
    })

    it('adds package keys the base never saw', () => {
        const merged = mergeVulnerabilityIndexes(new Map(), new Map([['nokogiri@1.13.8', [githubFinding()]]]))
        expect(merged.get('nokogiri@1.13.8')).toHaveLength(1)
    })
})
