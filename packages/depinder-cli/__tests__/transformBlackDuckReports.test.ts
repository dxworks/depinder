import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { transformBlackDuckReportsCommand, transformUpgradeGuidance } from '../src/commands/transformBlackDuckReports';
import { UPGRADE_GUIDANCE_COLUMNS } from '../src/blackduck/columns';

describe('transformUpgradeGuidance', () => {
    it('keeps CSV columns aligned when quoted values contain commas', () => {
        const input = `Used by,Component Id,Component Version Id,Component Origin Id,Component Name,Component Version Name,Component Origin Name,Component Origin External Id,Component Origin Version Name,Total Known Vulnerabilities,Short Term Recommended Version Id,Short Term Recommended Version Name,Short Term Recommended Component Origin Id,Short Term Recommended Origin Name,Short Term Recommended Origin Id,Short Term Recommended Origin Version Name,Short Term Critical Vulnerability,Short Term High Vulnerability,Short Term Medium Vulnerability,Short Term Low Vulnerability,Long Term Recommended Version Id,Long Term Recommended Version Name,Long Term Recommended Component Origin Id,Long Term Recommended Origin Name,Long Term Recommended Origin Id,Long Term Recommended Origin Version Name,Long Term Critical Vulnerability,Long Term High Vulnerability,Long Term Medium Vulnerability,Long Term Low Vulnerability,Knowledgebase Timed Out\n,component-id-1,component-version-id-1,component-origin-id-1,"Sample HTTP Service, API, WebSocket",1.2.3,sample-origin,sample:package:1.2.3,"Sample HTTP Service, API, WebSocket",4,recommended-version-id-short,2.0.0,recommended-component-origin-id-short,sample-origin,sample:package:2.0.0,2.0.0,0,0,0,0,recommended-version-id-long,2.0.0,recommended-component-origin-id-long,sample-origin,sample:package:2.0.0,2.0.0,0,0,0,0,FALSE`;

        const output = transformUpgradeGuidance(input);
        const [header, data] = output.trimEnd().split('\n');

        expect(header).toBe('Component Name,Component Version Name,Component Origin Name,Component Version Origin Id,Total Known Vulnerabilities,Short Term Recommended Version Name,Short Term Recommended Origin Name,Short Term Recommended Origin Id,Short Term Recommended Origin Version Name,Short Term Critical Vulnerability,Short Term High Vulnerability,Short Term Medium Vulnerability,Short Term Low Vulnerability,Long Term Recommended Version Name,Long Term Recommended Origin Name,Long Term Recommended Origin Id,Long Term Recommended Origin Version Name,Long Term Critical Vulnerability,Long Term High Vulnerability,Long Term Medium Vulnerability,Long Term Low Vulnerability');
        expect(header).toBe(UPGRADE_GUIDANCE_COLUMNS.join(','));
        expect(data).toContain('sample:package:1.2.3,4,2.0.0,sample-origin');
        expect(data).not.toContain('sample:package:1.2.3,recommended-version-id-short');
    });
});

it('drops Project path from vulnerability details while keeping raw security input unchanged', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-transform-'));
    const securityFile = path.join(folder, 'security_test.csv');
    const security = 'Component name,Component version name,Component origin id,Vulnerability id,Project path,Published on,Overall score,CWE Ids\n'
        + 'example,1.0.0,example/1.0.0,CVE-2026-0001,legacy-project,7/24/26,7.5,[CWE-79]\n';
    try {
        fs.writeFileSync(path.join(folder, 'components_test.csv'), 'Component name,Version id\n');
        fs.writeFileSync(path.join(folder, 'source_test.csv'), 'Version id,Path\n');
        fs.writeFileSync(path.join(folder, 'project_version_upgrade_guidance_test.csv'), 'Component Name\n');
        fs.writeFileSync(securityFile, security);

        await transformBlackDuckReportsCommand.parseAsync([folder], {from: 'user'});
        const [header, row] = parse(fs.readFileSync(path.join(folder, '_vulnerability_details.csv'), 'utf8')) as string[][];

        expect(header).not.toContain('Project path');
        expect(header).toHaveLength(22);
        expect(row).toHaveLength(22);
        expect(Object.fromEntries(header.map((column, index) => [column, row[index]]))).toMatchObject({
            'Component Version Origin Id': 'example/1.0.0',
            'Published on': '\t2026-07-24',
            'Overall score': '7.5',
            'CWE Ids': '[CWE-79]',
        });
        expect(fs.readFileSync(securityFile, 'utf8')).toBe(security);
    } finally {
        fs.rmSync(folder, {recursive: true, force: true});
    }
});
