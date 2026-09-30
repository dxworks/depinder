/**
 * RFC 4180 CSV writing, shared by every report depinder emits.
 *
 * A cell containing a comma, a quote or a newline must be quoted, and embedded quotes doubled.
 * Versions carry commas in the wild — Maven range strings such as `[4.1,4.2000)` — and an unquoted
 * one splits into two cells, shifting every column after it for that row.
 */

function csvCell(value: unknown): string {
    const text = value === undefined || value === null ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvRow(cells: unknown[]): string {
    return cells.map(csvCell).join(',')
}

/** A row addressed by column name, as the Black Duck-shaped exports build them. */
export interface NamedRow {
    [column: string]: string
}

/**
 * A complete file: the header line, then one line per row, in the header's column order, ending
 * with a newline like `csv-stringify` does — so a file from here and one from
 * `transformBlackDuckReports` diff byte for byte.
 */
export function csvDocument(headers: readonly string[], rows: NamedRow[]): string {
    return [csvRow([...headers]), ...rows.map(row => csvRow(headers.map(it => row[it])))].join('\n') + '\n'
}
