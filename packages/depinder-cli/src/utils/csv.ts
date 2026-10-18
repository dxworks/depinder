/**
 * RFC 4180 CSV writing, shared by every CSV file the CLI emits.
 *
 * A cell containing a comma, a quote or a line break must be quoted, and embedded quotes doubled.
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

/** Every row as one line, each ending with a newline; no rows give an empty file. */
export function csvLines(rows: unknown[][]): string {
    return rows.map(row => csvRow(row) + '\n').join('')
}

/** A row addressed by column name, as the Black Duck-shaped exports build them. */
export interface NamedRow {
    [column: string]: string
}

/** A complete file: the header line, then one line per row in the header's column order. */
export function csvDocument(headers: readonly string[], rows: NamedRow[]): string {
    return csvLines([[...headers], ...rows.map(row => headers.map(it => row[it]))])
}

/** A file whose columns are the first row's keys; no rows give an empty file, header included. */
export function csvDocumentFromRows(rows: NamedRow[]): string {
    return rows.length === 0 ? '' : csvDocument(Object.keys(rows[0]), rows)
}
