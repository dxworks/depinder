// esbuild settings for the CLI bundle, on top of the build target's options in project.json.
const fs = require('fs')
const path = require('path')

const libraryEntry = path.join(__dirname, 'src', 'depinder.ts')

/** The bin (index.js) requires the library entry (depinder.js) at run time instead of bundling a second copy. */
const requireLibraryEntryAtRunTime = {
    name: 'require-library-entry-at-run-time',
    setup(build) {
        build.onResolve({filter: /^\.\/depinder$/}, args =>
            args.kind !== 'entry-point' && path.join(args.resolveDir, 'depinder.ts') === libraryEntry
                ? {path: './depinder.js', external: true}
                : undefined)
    },
}

/** Keeps the bin executable and drops the package.json copy @nx/esbuild puts in dist/ (the package has its own). */
const finishOutput = {
    name: 'finish-output',
    setup(build) {
        build.onEnd(result => {
            if (result.errors.length > 0) return
            const outDir = build.initialOptions.outdir ?? path.dirname(build.initialOptions.outfile)
            fs.chmodSync(path.join(outDir, 'index.js'), 0o755)
            fs.rmSync(path.join(outDir, 'package.json'), {force: true})
        })
    },
}

module.exports = {
    // .js, not .cjs: package.json's main and bin name dist/depinder.js and dist/index.js
    outExtension: {'.js': '.js'},
    plugins: [requireLibraryEntryAtRunTime, finishOutput],
}
