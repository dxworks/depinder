import {licenseColumns, licenseIdentity, licenseRisk} from '../src/blackduck/licenses'

/**
 * Expressions that mix operators or use brackets keep their structure in both outputs. The first
 * three are from the 2026-10-12 comparison run: orjson, libfuzzer-sys and @zone-eu/mailsplit.
 */
describe('licence expressions with structure', () => {
    it('keeps the brackets of a choice inside a conjunction', () => {
        expect(licenseColumns(['MPL-2.0 AND (Apache-2.0 OR MIT)'])).toEqual({
            names: '(Mozilla Public License 2.0 AND (MIT License OR Apache License 2.0))',
            families: 'PERMISSIVE,WEAK_RECIPROCAL',
        })
        expect(licenseIdentity('MPL-2.0 AND (Apache-2.0 OR MIT)')).toBe('MPL-2.0 AND (MIT OR Apache-2.0)')
    })

    it("orders each operator group the way Black Duck does, groups after the licences it places", () => {
        expect(licenseColumns(['(MIT OR Apache-2.0) AND NCSA'])).toEqual({
            names: '(University of Illinois/NCSA Open Source License AND (MIT License OR Apache License 2.0))',
            families: 'PERMISSIVE',
        })
        expect(licenseIdentity('(MIT OR Apache-2.0) AND NCSA')).toBe('NCSA AND (MIT OR Apache-2.0)')
    })

    it('keeps an operand it cannot read, as written, with family UNKNOWN', () => {
        expect(licenseColumns(['(MIT OR EUPL-1.1+)'])).toEqual({
            names: '(MIT License OR EUPL-1.1+)',
            families: 'PERMISSIVE,UNKNOWN',
        })
        expect(licenseIdentity('(MIT OR EUPL-1.1+)')).toBe('MIT OR EUPL-1.1+')
        expect(licenseColumns(['Apache-2.0 WITH LLVM-exception OR MIT']).names)
            .toBe('(MIT License OR Apache-2.0 WITH LLVM-exception)')
    })

    it('binds AND tighter than OR, as SPDX does', () => {
        expect(licenseColumns(['MIT OR Apache-2.0 AND GPL-3.0']).names)
            .toBe('(MIT License OR (Apache License 2.0 AND GNU General Public License v3.0))')
        expect(licenseIdentity('MIT OR Apache-2.0 AND GPL-3.0')).toBe('MIT OR (Apache-2.0 AND GPL-3.0)')
        expect(licenseIdentity('gpl-3.0 or (mit and bsd-3-clause)')).toBe('GPL-3.0 OR (MIT AND BSD-3-Clause)')
    })

    it('folds nested groups of the same operator into one', () => {
        expect(licenseIdentity('((MIT OR Apache-2.0) OR Unlicense)')).toBe('MIT OR Apache-2.0 OR Unlicense')
        expect(licenseIdentity('MIT AND (MIT AND MIT)')).toBe('MIT')
    })

    it('reads brackets that belong to a name as part of the name', () => {
        const cell = '((MIT License OR Apache License 2.0) AND Unicode License Agreement - Data Files and Software (2016))'
        expect(licenseIdentity(cell)).toBe('(MIT OR Apache-2.0) AND Unicode-DFS-2016')
        expect(licenseColumns([cell]).names).toBe(cell)
    })

    it('splits on every operator when the brackets do not balance', () => {
        expect(licenseIdentity('MIT OR (Apache-2.0')).toBe('MIT OR Apache-2.0')
    })

    it('writes back what it reads, in both outputs', () => {
        for (const expression of ['MPL-2.0 AND (Apache-2.0 OR MIT)', '(MIT OR Apache-2.0) AND NCSA',
            '(MIT OR EUPL-1.1+)', 'MIT OR Apache-2.0 AND GPL-3.0']) {
            expect(licenseColumns([licenseIdentity(expression)])).toEqual(licenseColumns([expression]))
        }
    })

    it('keeps the risk of a mixed expression a conjunction of all its licences', () => {
        expect(licenseRisk(['MPL-2.0 AND (Apache-2.0 OR MIT)'])).toBe('MEDIUM')
        expect(licenseRisk(['(MIT OR Apache-2.0) AND NCSA'])).toBe('OK')
        expect(licenseRisk(['(MIT OR EUPL-1.1+)'])).toBe('OK')
        expect(licenseRisk(['(MIT OR Apache-2.0) AND GPL-3.0'])).toBe('HIGH')
    })
})
