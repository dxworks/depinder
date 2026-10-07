import {describe, expect, it} from 'vitest'
import {checkDependencies, type LockPackages, type Manifest} from '../src/dependency-rules.mts'

const root: Manifest = {location: '', devDependencies: {typescript: '^5.0.0'}}
const cli: Manifest = {location: 'packages/cli', dependencies: {semver: '^7.7.0'}}

describe('checkDependencies', () => {
    it('passes one version of everything', () => {
        const lock: LockPackages = {'node_modules/semver': {version: '7.8.4'}, 'node_modules/typescript': {version: '5.9.3'}}
        expect(checkDependencies([root, cli], lock).errors).toEqual([])
    })

    it('fails two projects declaring different ranges', () => {
        const server: Manifest = {location: 'packages/server', dependencies: {semver: '^7.8.0'}}
        const {errors} = checkDependencies([root, cli, server], {'node_modules/semver': {version: '7.8.4'}})
        expect(errors).toEqual(['semver is declared with different ranges: packages/cli dependencies ^7.7.0, packages/server dependencies ^7.8.0'])
    })

    it('fails projects resolving different versions', () => {
        const server: Manifest = {location: 'packages/server', dependencies: {semver: '^7.7.0'}}
        const lock: LockPackages = {
            'node_modules/semver': {version: '7.8.4'},
            'packages/server/node_modules/semver': {version: '7.7.3'},
        }
        expect(checkDependencies([root, cli, server], lock).errors[0]).toBe('semver resolves to different versions in workspace projects: 7.8.4, 7.7.3')
    })

    it('fails a nested copy in the same major, notes one of another major', () => {
        const lock: LockPackages = {
            'node_modules/semver': {version: '7.8.4'},
            'node_modules/some-tool/node_modules/semver': {version: '7.5.0'},
            'node_modules/@babel/core/node_modules/semver': {version: '6.3.1'},
        }
        const report = checkDependencies([root, cli], lock)
        expect(report.errors).toEqual(['semver 7.5.0 at node_modules/some-tool/node_modules/semver duplicates the workspace\'s 7.8.4'])
        expect(report.notes).toEqual(['semver 6.3.1 at node_modules/@babel/core/node_modules/semver: another major, private to that package'])
    })

    it('ignores the linked entries of workspace projects', () => {
        const lock: LockPackages = {'node_modules/semver': {version: '7.8.4'}, 'node_modules/cli': {link: true}}
        expect(checkDependencies([root, cli], lock).errors).toEqual([])
    })
})
