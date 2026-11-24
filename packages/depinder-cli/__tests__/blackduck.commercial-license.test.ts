import fs from 'fs'
import os from 'os'
import path from 'path'
import {parse} from 'csv-parse/sync'
import {writeBlackDuckExport} from '../src/blackduck/export'
import {buildModel} from '../src/blackduck/model'
import {dependency, ecosystem} from './fixtures/blackduck'

it('classifies the Commercial label as restricted proprietary in both reports', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-commercial-'))
    try {
        const model = buildModel('demo', [ecosystem(dependency({
            name: 'ag-grid-enterprise', version: '1.0.0', vulnerabilities: [],
            libraryInfo: {name: 'ag-grid-enterprise', licenses: ['Commercial'], versions: []},
        }))], [{name: 'ag-grid-enterprise', version: '1.0.0', purlType: 'npm', path: 'demo/-npm/ag-grid-enterprise/1.0.0',
            projectFilePath: '', projectPath: 'demo', matchType: 'Direct Dependency'}])

        writeBlackDuckExport(model, folder)

        const expected = {'License names': 'Commercial', 'License families': 'RESTRICTED_PROPRIETARY', 'License Risk': 'MEDIUM'}
        const dependencies = parse(fs.readFileSync(path.join(folder, '_dependencies.csv'), 'utf8'), {columns: true})
        const sources = parse(fs.readFileSync(path.join(folder, '_dependencies_sources.csv'), 'utf8'), {columns: true})
        expect(dependencies).toMatchObject([expected])
        expect(sources).toMatchObject([expected])
    } finally {
        fs.rmSync(folder, {recursive: true, force: true})
    }
})
