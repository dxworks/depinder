import {licenseColumns} from '../src/blackduck/licenses'
import {buildModel} from '../src/blackduck/model'
import {componentLink} from '../src/blackduck/origins'
import {upgradeGuidanceRows} from '../src/blackduck/export'
import {dependency, ecosystem} from './fixtures/blackduck'

describe('component reports from analysed dependencies', () => {
    it.each([
        ['npm', '@babel/core', '7.0.0', 'npmjs', '@babel/core/7.0.0'],
        ['gem', 'actionmailer', '8.1.3.1', 'rubygems', 'actionmailer/8.1.3.1'],
        ['maven', 'commons-logging:commons-logging', '1.2', 'maven', 'commons-logging:commons-logging:1.2'],
        ['composer', 'monolog/monolog', '3.9.0', 'packagist', 'monolog/monolog:3.9.0'],
        ['cargo', 'aho-corasick', '1.1.2', 'crates', 'aho-corasick/1.1.2'],
        ['conan', 'lib', '1.0.0', 'unknown', 'lib/1.0.0'],
        ['golang', 'github.com/Masterminds/semver/v3', 'v3.4.0', 'github', 'Masterminds/semver:v3.4.0'],
        ['golang', 'golang.org/x/sys', 'v0.47.0', 'long_tail', 'go.googlesource.com/sys#v0.47.0'],
        ['golang', 'golang.org/x/crypto/x509roots/fallback', 'v0.0.0-20260709184058-243e02a382f8', 'long_tail', 'go.googlesource.com/crypto#243e02a382f8'],
        ['golang', 'go.uber.org/zap', 'v1.28.0', 'unknown', 'go.uber.org/zap:v1.28.0'],
        ['golang', 'github.com/owner/repo', 'v0.0.0-20210328193216-ff5ff6dc229b', 'github', 'owner/repo:ff5ff6dc229b'],
        ['golang', 'github.com/owner/repo', 'v1.1.8-0.20240110162603-74a5dd331745', 'github', 'owner/repo:74a5dd331745'],
        ['golang', 'github.com/owner/repo', 'v2.0.0-pre.0.20230729083705-37449abec8cc', 'github', 'owner/repo:37449abec8cc'],
        ['golang', 'github.com/owner/repo', 'v1.5.4', 'github', 'owner/repo:v1.5.4'],
        ['golang', 'github.com/owner/repo', 'v1.2.3-beta.1', 'github', 'owner/repo:v1.2.3-beta.1'],
    ])('%s component %s@%s retains its Black Duck join key', (purlType, name, version, origin, id) => {
        const input = {...ecosystem(dependency({name, version})), purlType}

        const model = buildModel('demo', [input], [])

        expect(model.components).toMatchObject([{name, version, origin: {name: origin}, originId: id}])
    })

    it.each([
        ['npm', 'qs', 'https://example.test', 'https://example.test'],
        ['gem', 'rails', undefined, ''],
        ['npm', 'qs', '  ', ''],
        ['maven', 'g:a', undefined, ''],
        ['golang', 'github.com/beorn7/perks', undefined, 'https://github.com/beorn7/perks'],
        ['golang', 'github.com/dgraph-io/badger/v2', undefined, 'https://github.com/dgraph-io/badger'],
        ['golang', 'github.com/dgraph-io/badger/v2', 'https://open.dgraph.io/post/badger/', 'https://open.dgraph.io/post/badger/'],
        ['golang', 'go.uber.org/zap', undefined, ''],
        ['npm', 'lib', 'git+https://github.com/php-http/httplug.git', 'https://github.com/php-http/httplug'],
        ['npm', 'lib', 'git://github.com/dominictarr/through.git', 'https://github.com/dominictarr/through'],
        ['npm', 'lib', 'git@github.com:goinstant/buffer-equal-constant-time.git', 'https://github.com/goinstant/buffer-equal-constant-time'],
        ['npm', 'lib', 'ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
        ['npm', 'lib', 'https://github.com/sindresorhus/quick-lru#readme', 'https://github.com/sindresorhus/quick-lru#readme'],
        ['npm', 'lib', 'git+https://github.com/gregberge/svgr.git#main', 'https://github.com/gregberge/svgr#main'],
        ['npm', 'lib', 'mailto:maintainer@example.test', ''],
        ['npm', 'lib', '../relative/path', ''],
        ['npm', 'lib', undefined, ''],
    ])('%s component %s publishes a browser link from %s', (purlType, name, homepageUrl, expected) => {
        const input = {...ecosystem(dependency({name, libraryInfo: {name, homepageUrl, licenses: [], versions: []}})), purlType}
        const [component] = buildModel('demo', [input], []).components

        const link = componentLink(component.origin, component.name, component.homepageUrl)

        expect(link).toBe(expected)
    })

    it.each([
        {scenario: 'MIT', versionLicense: 'MIT', library: [], names: 'MIT License', families: 'PERMISSIVE'},
        {scenario: 'version licence overrides current package licence', versionLicense: 'Apache-2.0', library: ['MIT'], names: 'Apache License 2.0', families: 'PERMISSIVE'},
        {scenario: 'weak reciprocal licence', versionLicense: 'MPL-2.0', library: [], names: 'Mozilla Public License 2.0', families: 'WEAK_RECIPROCAL'},
        {scenario: 'SPDX choice', versionLicense: 'MIT OR Apache-2.0', library: [], names: '(MIT License OR Apache License 2.0)', families: 'PERMISSIVE'},
        {scenario: 'SPDX conjunction ordered for Black Duck', versionLicense: 'GPL-3.0 AND MIT', library: [], names: '(MIT License AND GNU General Public License v3.0)', families: 'PERMISSIVE,RECIPROCAL'},
        {scenario: 'readable version shorthand wins', versionLicense: 'MIT/Apache-2.0', library: ['MPL-2.0'], names: '(MIT License OR Apache License 2.0)', families: 'PERMISSIVE'},
        {scenario: 'unreadable version falls back to known package licence', versionLicense: 'Weird-1.0', library: ['MIT'], names: 'MIT License', families: 'PERMISSIVE'},
        {scenario: 'unmapped version retained when package licence is also unknown', versionLicense: 'BSD-like', library: ['Also-Not-SPDX'], names: 'BSD-like', families: 'UNKNOWN'},
        {scenario: 'missing version licence falls back to package', versionLicense: undefined, library: ['BSD-3-Clause'], names: 'BSD 3-clause "New" or "Revised" License', families: 'PERMISSIVE'},
        {scenario: 'unknown package licence stays visible', versionLicense: undefined, library: ['Weird-1.0'], names: 'Weird-1.0', families: 'UNKNOWN'},
        {scenario: 'no licence information', versionLicense: undefined, library: [], names: 'Unknown License', families: 'UNKNOWN'},
    ])('licence report: $scenario', ({versionLicense, library, names, families}) => {
        const dep = dependency({libraryInfo: {name: 'qs', licenses: library,
            versions: [{version: '6.10.2', timestamp: 0, latest: true, licenses: versionLicense}]}})

        const result = licenseColumns(buildModel('demo', [ecosystem(dep)], []).components[0].licenses)

        expect(result).toEqual({names, families})
    })

    const releases = [
        {version: '6.10.2', timestamp: Date.parse('2021-10-06'), latest: false},
        {version: '6.9.9', timestamp: Date.parse('2022-01-01'), latest: false},
        {version: '7.0.0-alpha.1', timestamp: Date.parse('2020-01-01'), latest: false},
        {version: '7.0.0', timestamp: Date.parse('2022-06-01'), latest: true},
    ]
    it.each([
        {scenario: 'backports count by date, pre-releases by number', versions: releases, current: '6.10.2', date: '2021-10-06', byDate: '2', byNumber: '2'},
        {scenario: 'removing pre-release affects only numeric count', versions: releases.filter(it => it.version !== '7.0.0-alpha.1'), current: '6.10.2', date: '2021-10-06', byDate: '2', byNumber: '1'},
        {scenario: 'unknown installed version has no date or date count', versions: releases, current: '6.10.1', date: '', byDate: '', byNumber: '3'},
        {scenario: 'invalid release date stays blank', versions: [{version: '6.10.2', timestamp: NaN, latest: true}], current: '6.10.2', date: '', byDate: '', byNumber: '0'},
    ])('$scenario', ({versions, current, date, byDate, byNumber}) => {
        const dep = dependency({version: current, libraryInfo: {name: 'qs', licenses: [], versions}})

        const model = buildModel('demo', [ecosystem(dep)], [])

        expect(model.components).toMatchObject([{releaseDate: date, newerVersions: byDate, newerVersionsSemver: byNumber}])
    })

    it('keeps the installed release date while excluding withdrawn versions from counts and recommendations', () => {
        const dep = dependency({libraryInfo: {name: 'qs', licenses: [], versions: [
            {version: '6.10.2', timestamp: Date.parse('2021-10-06'), latest: false, yanked: true},
            {version: '6.10.3', timestamp: Date.parse('2022-01-01'), latest: false},
            {version: '6.12.0', timestamp: Date.parse('2022-06-01'), latest: false, yanked: true},
            {version: '7.0.0', timestamp: Date.parse('2023-01-01'), latest: true, yanked: true},
        ]}})

        const model = buildModel('demo', [ecosystem(dep)], [])

        expect(model.components).toMatchObject([{releaseDate: '2021-10-06', newerVersions: '1', newerVersionsSemver: '1'}])
        expect(upgradeGuidanceRows(model.components)).toMatchObject([{
            'Short Term Recommended Version Name': '6.10.3', 'Long Term Recommended Version Name': '6.10.3',
        }])
    })
})
