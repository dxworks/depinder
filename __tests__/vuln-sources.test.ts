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
import {SECURITY_CSV_HEADERS, securityRowsFor, securityRowsForProjects} from '../src/vuln-sources/security-csv'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
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

describe('sbom-security.csv rows', () => {
    const vulnerability: Vulnerability = {
        severity: 'HIGH',
        score: 9.8,
        description: 'qs prototype pollution',
        permalink: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
        timestamp: Date.parse('2022-11-27T00:30:50Z'),
        identifiers: [
            {value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'},
            {value: 'CVE-2022-24999', type: 'CVE'},
        ],
        firstPatchedVersion: '6.10.3',
        source: 'github',
        cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        cvssVersion: '3.1',
        cweIds: ['CWE-1321'],
    }

    const dependency = (overrides: Partial<DepinderDependency> = {}): DepinderDependency => ({
        id: 'qs@6.10.2',
        name: 'qs',
        version: '6.10.2',
        semver: null,
        // Direct: requested by the project itself, the same rule libs.csv's DirectDependency uses.
        requestedBy: ['js-npm-nest@1.0.0'],
        vulnerabilities: [vulnerability],
        ...overrides,
    } as DepinderDependency)

    const project: DepinderProject = {
        name: 'js-npm-nest',
        version: '1.0.0',
        path: 'package.json',
        dependencies: {},
    }

    it('fills every Black Duck column from the internal model', () => {
        const [row] = securityRowsFor(project, dependency(), 'npm')
        expect(Object.keys(row).sort()).toEqual([...SECURITY_CSV_HEADERS].sort())
        expect(row).toEqual({
            'Component name': 'qs',
            'Component version name': '6.10.2',
            'Component Version Origin Id': 'qs/6.10.2',
            'Origin name': 'npm',
            'Vulnerability id': 'GHSA-hrpp-h998-j3pp',
            'CVE ids': 'CVE-2022-24999',
            'Vulnerability source': 'github',
            'Published on': '2022-11-27T00:30:50.000Z',
            'Base score': '9.8',
            'CVSS Version': '3.1',
            'CVSS vector': 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
            'Security Risk': 'High',
            'CWE Ids': 'CWE-1321',
            'Solution available': 'true',
            'Fixed version': '6.10.3',
            'Match type': 'Direct',
            'Project path': 'package.json',
        })
    })

    it('calls a dependency transitive when nothing in the project requested it directly', () => {
        const [row] = securityRowsFor(project, dependency({requestedBy: ['express@4.18.0']}), 'npm')
        expect(row['Match type']).toBe('Transitive')
    })

    it('says no solution is available when no fixed version is named', () => {
        const withoutFix = {...vulnerability, firstPatchedVersion: undefined}
        const [row] = securityRowsFor(project, dependency({vulnerabilities: [withoutFix]}), 'npm')
        expect(row['Solution available']).toBe('false')
        expect(row['Fixed version']).toBe('')
    })

    it('emits one row per (component, advisory, project) and none for a clean component', () => {
        const withTwo = dependency({vulnerabilities: [vulnerability, {...vulnerability, identifiers: [{value: 'GHSA-2', type: 'GHSA'}]}]})
        const clean = dependency({id: 'lodash@4.17.21', name: 'lodash', version: '4.17.21', vulnerabilities: []})
        const populated: DepinderProject = {...project, dependencies: {[withTwo.id]: withTwo, [clean.id]: clean}}
        expect(securityRowsForProjects([populated], 'npm')).toHaveLength(2)
    })
})
