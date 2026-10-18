import fs from 'fs'
import os from 'os'
import path from 'path'
import {walkDir} from '../src/utils/utils'

describe('walkDir', () => {
    let root: string

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-walk-dir-'))
    })
    afterEach(() => fs.rmSync(root, {recursive: true, force: true}))

    function write(relativePath: string) {
        const file = path.join(root, relativePath)
        fs.mkdirSync(path.dirname(file), {recursive: true})
        fs.writeFileSync(file, '')
    }

    it('lists every file at any depth, as absolute paths, and no directories', () => {
        write('package.json')
        write('app/package-lock.json')
        write('app/nested/deeper/pom.xml')
        fs.mkdirSync(path.join(root, 'empty'))

        expect(walkDir(root).sort()).toEqual([
            path.join(root, 'app/nested/deeper/pom.xml'),
            path.join(root, 'app/package-lock.json'),
            path.join(root, 'package.json'),
        ])
    })

    it('does not follow symlinks', () => {
        write('real/package.json')
        fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked-dir'))
        fs.symlinkSync(path.join(root, 'real/package.json'), path.join(root, 'linked.json'))

        expect(walkDir(root)).toEqual([path.join(root, 'real/package.json')])
    })
})
