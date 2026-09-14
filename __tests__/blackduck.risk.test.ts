import {licenseColumns, licenseRisk, licenseRiskFromNames} from '../src/blackduck/licenses'
import {operationalRisk} from '../src/blackduck/risk'

/**
 * Both rules were inferred from the reference Black Duck export rather than from a published
 * specification, so the cases below are the evidence, quoted: each one is a row (or a pair of rows)
 * that actually appears in `components_*.csv` and pins the behaviour it demonstrates.
 */

describe('License Risk', () => {
    it('maps a single licence by its family', () => {
        expect(licenseRisk(['MIT'])).toBe('OK')                    // PERMISSIVE, 8,191 rows
        expect(licenseRisk(['Apache-2.0'])).toBe('OK')
        expect(licenseRisk(['MPL-2.0'])).toBe('MEDIUM')            // WEAK_RECIPROCAL, 72 rows
        expect(licenseRisk(['GPL-3.0'])).toBe('HIGH')              // RECIPROCAL, 2 rows
    })

    it('treats a licence it cannot identify as the worst case, as Black Duck does', () => {
        expect(licenseRisk(['NOT-AN-SPDX-ID'])).toBe('UNKNOWN')
        expect(licenseRisk([])).toBe('UNKNOWN')
        expect(licenseRisk(['', '  '])).toBe('UNKNOWN')
        // Black Duck says HIGH here, from a Knowledge Base we do not have. Saying UNKNOWN is the
        // difference between "we read a risky licence" and "we could not read one".
        expect(licenseRisk(['https://example.com/LICENSE.txt'])).toBe('UNKNOWN')
    })

    /**
     * The pair that proves the operator is what decides. Both rows are in the reference export,
     * both are `PERMISSIVE,WEAK_RECIPROCAL` in the families column, and they disagree on risk.
     */
    it('reads OR as a choice and AND as a conjunction', () => {
        expect(licenseRisk(['BSD-2-Clause OR Ruby'])).toBe('OK')
        expect(licenseRisk(['BSD-2-Clause AND Ruby'])).toBe('MEDIUM')
        expect(licenseRisk(['Apache-2.0 OR EPL-2.0'])).toBe('OK')
        expect(licenseRisk(['Apache-2.0 AND EPL-2.0'])).toBe('MEDIUM')
    })

    it('takes the most permissive branch of a choice, however it is written', () => {
        expect(licenseRisk(['LGPL-2.1-or-later OR MIT OR Apache-2.0'])).toBe('OK')
        expect(licenseRisk(['GPL-3.0 OR MIT'])).toBe('OK')
        expect(licenseRisk(['gpl-3.0 or mit'])).toBe('OK')         // operators are case-insensitive
    })

    it('carries every obligation of a conjunction', () => {
        expect(licenseRisk(['MIT AND OFL-1.1 AND CC-BY-3.0'])).toBe('MEDIUM')  // OFL-1.1 is WEAK_RECIPROCAL
        // An operand we cannot read can only be as bad as HIGH, so a conjunction that already
        // reaches HIGH keeps its answer, and one that does not cannot claim one.
        expect(licenseRisk(['GPL-3.0 AND NOT-AN-SPDX-ID'])).toBe('HIGH')
        expect(licenseRisk(['MIT AND NOT-AN-SPDX-ID'])).toBe('UNKNOWN')
        // The mirror image for a choice: a branch we cannot read cannot beat an OK one.
        expect(licenseRisk(['MIT OR NOT-AN-SPDX-ID'])).toBe('OK')
        expect(licenseRisk(['GPL-3.0 OR NOT-AN-SPDX-ID'])).toBe('UNKNOWN')
        expect(licenseRisk(['MIT AND MPL-2.0'])).toBe('MEDIUM')
    })

    it('treats several licences listed side by side as a conjunction', () => {
        expect(licenseRisk(['MIT', 'GPL-3.0'])).toBe('HIGH')
        expect(licenseRisk(['MIT', 'Apache-2.0'])).toBe('OK')
    })

    it('reads a mixed expression as a conjunction rather than modelling precedence', () => {
        expect(licenseRisk(['MIT OR Apache-2.0 AND GPL-3.0'])).toBe('HIGH')
    })
})

describe('License Risk read off a written cell', () => {
    it('agrees with the SPDX-id rule on the cells that rule produces', () => {
        expect(licenseRiskFromNames('MIT License')).toBe('OK')
        expect(licenseRiskFromNames('Mozilla Public License 2.0')).toBe('MEDIUM')
        expect(licenseRiskFromNames('GNU General Public License v3.0')).toBe('HIGH')
        expect(licenseRiskFromNames('Unknown License')).toBe('UNKNOWN')
        expect(licenseRiskFromNames('')).toBe('UNKNOWN')
    })

    it('keeps the operator rule through the rendered parentheses', () => {
        expect(licenseRiskFromNames('(BSD 2-clause "Simplified" License OR Ruby License)')).toBe('OK')
        expect(licenseRiskFromNames('(BSD 2-clause "Simplified" License AND Ruby License)')).toBe('MEDIUM')
    })

    /** A comma joins several licences; it must not be read as a break inside one expression. */
    it('splits on top-level commas only', () => {
        expect(licenseRiskFromNames('MIT License,GNU General Public License v3.0')).toBe('HIGH')
        expect(licenseRiskFromNames('(MIT License OR Apache License 2.0)')).toBe('OK')
        expect(licenseRiskFromNames('(MIT License OR Apache License 2.0),MIT License')).toBe('OK')
    })

    it('is what the exporter would have written, for every cell it writes', () => {
        for (const ids of [['MIT'], ['GPL-3.0'], ['MIT', 'MPL-2.0'], ['BSD-2-Clause OR Ruby'],
            ['BSD-2-Clause AND Ruby'], ['Apache-2.0 OR EPL-2.0'], []]) {
            const {names} = licenseColumns(ids)
            expect(licenseRiskFromNames(names)).toBe(licenseRisk(ids))
        }
    })
})

describe('Operational Risk', () => {
    const asOf = new Date('2026-09-10T00:00:00Z')

    it('is OK on the newest version, however old that version is', () => {
        expect(operationalRisk('2026-08-01', '0', asOf)).toBe('OK')
        expect(operationalRisk('2015-01-01', '0', asOf)).toBe('OK')
    })

    it('grades a version you are behind on by how stale it is', () => {
        expect(operationalRisk('2026-01-01', '3', asOf)).toBe('LOW')       // under 2 years
        expect(operationalRisk('2024-01-01', '3', asOf)).toBe('MEDIUM')    // 2 to 4 years
        expect(operationalRisk('2020-01-01', '3', asOf)).toBe('HIGH')      // over 4 years
    })

    it('puts the thresholds at two and four years', () => {
        expect(operationalRisk('2024-09-11', '1', asOf)).toBe('LOW')
        expect(operationalRisk('2024-09-09', '1', asOf)).toBe('MEDIUM')
        expect(operationalRisk('2022-09-11', '1', asOf)).toBe('MEDIUM')
        expect(operationalRisk('2022-09-09', '1', asOf)).toBe('HIGH')
    })

    /** An empty cell is "we do not know", which is not the same statement as `OK`. */
    it('says nothing when it has nothing to say', () => {
        expect(operationalRisk('2024-01-01', '')).toBe('')
        expect(operationalRisk('', '3', asOf)).toBe('')
        expect(operationalRisk('not a date', '3', asOf)).toBe('')
        expect(operationalRisk('2024-01-01', 'many', asOf)).toBe('')
    })

    it('still answers OK with no release date, because zero newer versions is enough', () => {
        expect(operationalRisk('', '0', asOf)).toBe('OK')
    })
})

describe('reading a licence however it is written', () => {
    const names = (licenses: string[]): string => licenseColumns(licenses).names

    it('resolves the wordings registries actually use', () => {
        // Every string here occurs in the run being compared, and Black Duck reports all of them
        // as `Apache License 2.0`.
        for (const spelling of ['Apache-2.0', 'Apache 2.0', 'Apache 2', 'Apache License, Version 2.0',
            'The Apache Software License, Version 2.0', 'The Apache License, Version 2.0',
            'Apache-2.0 license', 'Apache License Version 2.0']) {
            expect(names([spelling])).toBe('Apache License 2.0')
        }
        expect(names(['The MIT License (MIT)'])).toBe('MIT License')
        expect(names(['MIT-License'])).toBe('MIT License')
        expect(names(['License :: OSI Approved :: MIT License'])).toBe('MIT License')
        expect(names(['Eclipse Public License v2.0'])).toBe('Eclipse Public License 2.0')
        expect(names(['GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1']))
            .toBe('GNU Lesser General Public License v2.1')
    })

    it('reads its own written cells back', () => {
        // What `recompute-derived-columns` has to work from: a finished export, not SPDX ids.
        expect(names(['MIT License'])).toBe('MIT License')
        expect(names(['(MIT License OR Apache License 2.0)'])).toBe('(MIT License OR Apache License 2.0)')
        expect(licenseRiskFromNames('(MIT License OR Apache License 2.0)')).toBe('OK')
    })

    it('takes the licence in front of a nuget licence URL, and only once', () => {
        expect(names(['MIT https://www.nuget.org/packages/Humanizer.Core/2.14.1/license']))
            .toBe('MIT License')
        // nuget repeats the licence once per manifest that declared it.
        expect(names(['MIT https://www.nuget.org/packages/a/1.0/license',
            'MIT https://www.nuget.org/packages/b/2.0/license'])).toBe('MIT License')
    })

    it('refuses to read what is not a licence name', () => {
        expect(names(['http://go.microsoft.com/fwlink/?LinkId=329770'])).toBe('Unknown License')
        expect(names(['SEE LICENSE IN LICENSE.txt'])).toBe('SEE LICENSE IN LICENSE.txt')
        expect(licenseRisk(['SEE LICENSE IN LICENSE.txt'])).toBe('UNKNOWN')
        // A package that pasted the licence text into the field: not a name, whatever its length.
        expect(names([`Redistribution and use in source and binary forms${' are permitted'.repeat(20)}`]))
            .toBe('Unknown License')
    })

    it('keeps a name containing "or" whole', () => {
        // The operand `later` is what a case-insensitive split used to produce here.
        expect(names(['GNU Lesser General Public License v2.1 or later']))
            .toBe('GNU Lesser General Public License v2.1 or later')
        expect(names(['LGPL-2.1-or-later'])).toBe('GNU Lesser General Public License v2.1 or later')
    })

    it("writes several licences in Black Duck's order", () => {
        // crates.io says `Unlicense OR MIT`; Black Duck reports `(MIT License OR The Unlicense)`.
        expect(names(['Unlicense OR MIT'])).toBe('(MIT License OR The Unlicense)')
        expect(names(['Unlicense/MIT'])).toBe('(MIT License OR The Unlicense)')
        // A gemspec lists them side by side; Black Duck reads the list as a choice it orders too.
        expect(names(['BSD-2-Clause', 'Ruby']))
            .toBe('BSD 2-clause "Simplified" License,Ruby License')
    })

    it('drops unreadable text that sits next to a licence it did read', () => {
        expect(names(['MIT', 'https://example.com/LICENSE'])).toBe('MIT License')
        expect(licenseColumns(['MIT', 'https://example.com/LICENSE']).families).toBe('PERMISSIVE')
    })
})
