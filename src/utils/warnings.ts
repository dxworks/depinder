/**
 * Silences the one warning `node:sqlite` prints on Node 24 (`ExperimentalWarning: SQLite is an
 * experimental feature`). It is the module the local cache is built on, and the warning would
 * otherwise open every run's output. Every other warning is printed the way Node prints it.
 *
 * Imported first by `index.ts`, before anything that requires `node:sqlite`.
 */
const isSqliteExperimental = (warning: Error) =>
    warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)

process.removeAllListeners('warning')
process.on('warning', warning => {
    if (isSqliteExperimental(warning)) return
    // The same shape Node's default handler prints, minus the stack for brevity.
    console.error(`(node:${process.pid}) ${warning.name}: ${warning.message}`)
})
