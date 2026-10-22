import fs from 'fs'
import path from 'path'
import {promisify} from 'util'
import type {ExecFileOptions} from 'child_process'

/**
 * Scanner fixtures must be real child processes, but a #!/bin/sh script cannot be spawned on
 * Windows (EFTYPE). A .scanner.cjs fixture launched through the current Node runs everywhere.
 * nodeScannerExecFile routes only those fixture files through process.execPath; every other
 * execFile call, including missing binaries, reaches the real implementation unchanged, so
 * ENOENT, stderr and exit codes stay genuine.
 */
export function writeNodeScanner(folder: string, name: string, source: string): string {
    const file = path.join(folder, `${name}.scanner.cjs`)
    fs.writeFileSync(file, source)
    return file
}

export function nodeScannerExecFile(actualExecFile: typeof import('child_process').execFile) {
    const run = promisify(actualExecFile)
    const custom = (file: string, args: string[], options?: ExecFileOptions) =>
        file.endsWith('.scanner.cjs')
            ? run(process.execPath, [file, ...args], options)
            : run(file, args, options)
    return Object.assign(
        () => { throw new Error('node-scanner only answers promisified execFile calls') },
        {[Symbol.for('nodejs.util.promisify.custom')]: custom},
    )
}
