import {csvDocumentFromRows, csvLines, csvRow} from '../src/utils/csv'

/** The one CSV writer behind every CSV file the CLI emits. */

describe('csvRow', () => {
    it('quotes a cell containing a comma', () => {
        expect(csvRow(['a', 'b,c', 'd'])).toBe('a,"b,c",d')
    })

    it('doubles embedded quotes', () => {
        expect(csvRow(['say "hi"'])).toBe('"say ""hi"""')
    })

    it('quotes a cell containing a newline', () => {
        expect(csvRow(['line1\nline2'])).toBe('"line1\nline2"')
    })

    it('writes an empty cell for undefined rather than the string undefined', () => {
        expect(csvRow(['a', undefined, 'b'])).toBe('a,,b')
    })

    it('leaves an ordinary cell unquoted', () => {
        expect(csvRow(['a', 1, true])).toBe('a,1,true')
    })
})

describe('csvLines', () => {
    it('ends every line, the last included, with a newline', () => {
        expect(csvLines([['h1', 'h2'], ['a', 'b']])).toBe('h1,h2\na,b\n')
    })

    it('quotes commas, quotes and line breaks inside one row', () => {
        expect(csvLines([['a,b', 'say "hi"', 'line1\r\nline2', 'plain']]))
            .toBe('"a,b","say ""hi""","line1\r\nline2",plain\n')
    })

    it('writes nothing for no rows', () => {
        expect(csvLines([])).toBe('')
    })
})

describe('csvDocumentFromRows', () => {
    it('takes the columns from the first row, in its key order', () => {
        const rows = [{Name: 'qs', 'Licence, full': 'BSD "New"'}, {'Licence, full': 'MIT', Name: 'a\nb'}]
        expect(csvDocumentFromRows(rows))
            .toBe('Name,"Licence, full"\nqs,"BSD ""New"""\n"a\nb",MIT\n')
    })

    it('leaves a cell empty when a later row lacks the column', () => {
        expect(csvDocumentFromRows([{a: '1', b: '2'}, {a: '3'}])).toBe('a,b\n1,2\n3,\n')
    })

    it('writes nothing, not even a header, for no rows', () => {
        expect(csvDocumentFromRows([])).toBe('')
    })
})
