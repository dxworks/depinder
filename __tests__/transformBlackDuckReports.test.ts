import { transformUpgradeGuidance } from '../src/commands/transformBlackDuckReports';

describe('transformUpgradeGuidance', () => {
    it('keeps CSV columns aligned when quoted values contain commas', () => {
        const input = `Used by,Component Id,Component Version Id,Component Origin Id,Component Name,Component Version Name,Component Origin Name,Component Origin External Id,Component Origin Version Name,Total Known Vulnerabilities,Short Term Recommended Version Id,Short Term Recommended Version Name,Short Term Recommended Component Origin Id,Short Term Recommended Origin Name,Short Term Recommended Origin Id,Short Term Recommended Origin Version Name,Short Term Critical Vulnerability,Short Term High Vulnerability,Short Term Medium Vulnerability,Short Term Low Vulnerability,Long Term Recommended Version Id,Long Term Recommended Version Name,Long Term Recommended Component Origin Id,Long Term Recommended Origin Name,Long Term Recommended Origin Id,Long Term Recommended Origin Version Name,Long Term Critical Vulnerability,Long Term High Vulnerability,Long Term Medium Vulnerability,Long Term Low Vulnerability,Knowledgebase Timed Out\n,component-id-1,component-version-id-1,component-origin-id-1,"Sample HTTP Service, API, WebSocket",1.2.3,sample-origin,sample:package:1.2.3,"Sample HTTP Service, API, WebSocket",4,recommended-version-id-short,2.0.0,recommended-component-origin-id-short,sample-origin,sample:package:2.0.0,2.0.0,0,0,0,0,recommended-version-id-long,2.0.0,recommended-component-origin-id-long,sample-origin,sample:package:2.0.0,2.0.0,0,0,0,0,FALSE`;

        const output = transformUpgradeGuidance(input);
        const [header, data] = output.trimEnd().split('\n');

        expect(header).toBe('Component Name,Component Version Name,Component Origin Name,Component Version Origin Id,Total Known Vulnerabilities,Short Term Recommended Version Name,Short Term Recommended Origin Name,Short Term Recommended Origin Id,Short Term Recommended Origin Version Name,Short Term Critical Vulnerability,Short Term High Vulnerability,Short Term Medium Vulnerability,Short Term Low Vulnerability,Long Term Recommended Version Name,Long Term Recommended Origin Name,Long Term Recommended Origin Id,Long Term Recommended Origin Version Name,Long Term Critical Vulnerability,Long Term High Vulnerability,Long Term Medium Vulnerability,Long Term Low Vulnerability');
        expect(data).toContain('sample:package:1.2.3,4,2.0.0,sample-origin');
        expect(data).not.toContain('sample:package:1.2.3,recommended-version-id-short');
    });
});
