import path from 'path'

/**
 * Stubs the scanners at execFile: version/DB probes, DB-warm commands and per-file scan reports
 * ('ok' an empty report, 'fail' a throw, 'bad' non-JSON stdout), per the suite's control.
 */
export type ScanMode = 'ok' | 'fail' | 'bad'

export interface ScannerProcessControl {
    installed: {trivy: boolean, grype: boolean}
    scanDefault: {trivy: ScanMode, grype: ScanMode}
    /** Per input file basename -> per tool mode, overriding the tool default. */
    scanFiles: Record<string, {trivy?: ScanMode, grype?: ScanMode}>
}

export function stubScannerExecFile(control: ScannerProcessControl) {
    const enoent = (bin: string) => Object.assign(new Error(`spawn ${bin} ENOENT`), {code: 'ENOENT'})
    const out = (payload: object) => ({stdout: JSON.stringify(payload), stderr: ''})
    const scanResult = (tool: 'trivy' | 'grype', file: string) => {
        const mode = control.scanFiles[path.basename(file)]?.[tool] ?? control.scanDefault[tool]
        if (mode === 'fail') throw new Error(`synthetic ${tool} scan failure`)
        if (mode === 'bad') return {stdout: 'not json {', stderr: ''}
        return out(tool === 'trivy' ? {Results: []} : {matches: []})
    }
    const probe = async (bin: string, args: string[]) => {
        const tool = path.basename(bin)
        if (tool !== 'trivy' && tool !== 'grype') throw enoent(bin)
        if (!control.installed[tool as 'trivy' | 'grype']) throw enoent(bin)
        if (tool === 'trivy') {
            if (args.includes('--version')) {
                return out({Version: '0.74.0', VulnerabilityDB: {Version: 2, UpdatedAt: '2026-10-01T00:00:00Z'}})
            }
            if (args[0] === 'image') return {stdout: '', stderr: ''} // DB warm
            if (args[0] === 'sbom') return scanResult('trivy', String(args[args.length - 1]))
            throw new Error(`unexpected trivy call: ${args.join(' ')}`)
        }
        if (args.join(' ').includes('db status')) return out({schemaVersion: 'v6.1.9', built: '2026-10-01T00:00:00Z'})
        if (args.includes('version')) return out({version: '0.118.0'})
        if (args.join(' ') === 'db update') return {stdout: '', stderr: ''}
        if (String(args[0]).startsWith('sbom:')) return scanResult('grype', String(args[0]).slice('sbom:'.length))
        throw new Error(`unexpected grype call: ${args.join(' ')}`)
    }
    return Object.assign(
        () => { throw new Error('the scanner-process mock only answers promisified execFile calls') },
        {[Symbol.for('nodejs.util.promisify.custom')]: probe},
    )
}
