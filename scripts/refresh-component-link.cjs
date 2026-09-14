/**
 * Offline refresh of `Component Link` on a finished run.
 *
 * `Component Link` names the project a component belongs to, and the registries declare it in the
 * very response the registrars already fetch — but until now no registrar for npm, NuGet, Maven or
 * Packagist read the field, so the run's `libs.json` has no homepage to recompute from. This
 * script fills that gap without re-running `export-blackduck`, which would re-run trivy and grype
 * against today's vulnerability databases and quietly turn one run into a different one.
 *
 *   node scripts/refresh-component-link.cjs CACHE_DIR EXPORT_DIR [--only npmjs,maven] [--offline]
 *
 * It talks to package registries and to nothing else: no scanners, no package managers, no
 * vulnerability databases. A registry answer about a published package is the same answer today as
 * it was on the run's own date, so the pairing with the Black Duck export it is compared against
 * survives. What is fetched is written to `CACHE_DIR/homepages.json`, so a second run needs no
 * network at all; `--offline` refuses to fetch anything and rewrites from that file alone.
 *
 * The link itself is built by `componentLink` out of `dist/`, the exporter's own function, so this
 * script cannot drift from what a real export would write.
 */
const fs = require('fs');
const path = require('path');
const {parse, stringify} = require('csv/sync');
const {componentLink, originFor} = require('../dist/blackduck/origins');
const {plugins} = require('../dist/plugins');
const {mavenProjectUrl} = require('../dist/plugins/java');
const {ecosystemOf} = require('../dist/extension-points/plugin');

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const onlyAt = args.indexOf('--only');
const only = onlyAt === -1 ? null : new Set(args[onlyAt + 1].split(',').map(it => it.trim()));
const consumed = new Set(args.flatMap((it, i) => (it === '--offline' ? [i] : it === '--only' ? [i, i + 1] : [])));
const [cacheDir, exportDir] = args.filter((it, i) => !consumed.has(i));
if (!cacheDir || !exportDir) {
    throw new Error('Usage: node scripts/refresh-component-link.cjs CACHE_DIR EXPORT_DIR [--only origins] [--offline]');
}

/** Black Duck's origin vocabulary against the plugin ecosystem that can answer for it. Go's three
 *  origins all resolve through the module proxy, which is the only thing that knows a module. */
const ECOSYSTEM_OF_ORIGIN = {
    npmjs: 'npm', rubygems: 'ruby', packagist: 'php', pypi: 'python',
    nuget: 'dotnet', maven: 'java', crates: 'rust',
    github: 'go', long_tail: 'go', unknown: 'go',
};
/** The purl type each origin's components carry, so `originFor` reaches the same origin the export
 *  did — the name alone is ambiguous for Go, where the host decides the origin. */
const PURL_TYPE_OF_ORIGIN = {
    npmjs: 'npm', rubygems: 'gem', packagist: 'composer', pypi: 'pypi',
    nuget: 'nuget', maven: 'maven', crates: 'cargo',
    github: 'golang', long_tail: 'golang', unknown: 'golang',
};

const registrarOf = new Map(plugins.map(it => [ecosystemOf(it), it.registrar]));

const homepagesFile = path.join(cacheDir, 'homepages.json');
const homepages = fs.existsSync(homepagesFile) ? JSON.parse(fs.readFileSync(homepagesFile)) : {};

const depsFile = path.join(exportDir, '_dependencies.csv');
const rows = parse(fs.readFileSync(depsFile), {columns: true});
const nameColumn = Object.keys(rows[0]).find(it => it.endsWith('Component name'));

/** One lookup per component, not per row: the column is a property of the component, and a package
 *  with fourteen versions in the run must not cost fourteen requests. */
const wanted = new Map();
for (const row of rows) {
    const origin = row['Origin name'];
    if (only && !only.has(origin)) continue;
    const ecosystem = ECOSYSTEM_OF_ORIGIN[origin];
    if (!ecosystem) continue;
    const key = `${ecosystem}:${row[nameColumn]}`;
    if (!wanted.has(key)) wanted.set(key, {ecosystem, name: row[nameColumn], versions: []});
    wanted.get(key).versions.push(row['Component version name']);
}

/** `null` is "could not ask", `''` is "asked, the registry declares none". Recording a failure as
 *  an empty string would make it indistinguishable from a real answer and never be retried, so a
 *  failed lookup stays missing and comes back on the next run. */
const answered = key => key in homepages && homepages[key] !== null;
const missing = [...wanted.entries()].filter(([key]) => !answered(key));
const counts = {components: wanted.size, fetched: 0, failed: 0, cached: wanted.size - missing.length};

/**
 * How hard each registry may be hit at once.
 *
 * Maven Central's search API is not slow, it is throttled: the first request answers in half a
 * second and a burst of eight then aborts every one of them. Asking it on one connection, with a
 * pause, is the difference between 59 of 377 components answered and all of them. This is a
 * politeness setting, not a derivation, so keeping it here does not put the script at odds with
 * the exporter.
 */
const CONCURRENCY = {java: 6, npm: 8, dotnet: 6, php: 6, python: 6, ruby: 6, rust: 6, go: 6};
const DELAY_MS = {};

/**
 * Maven is fetched here rather than through its registrar, and this is the one place the script
 * departs from "ask the registrar what a real export would ask".
 *
 * The registrar reaches every pom through `search.maven.org` — first a paged solr query for the
 * artifact's whole version list, then the pom itself. That service rate-limits a sweep to a
 * standstill: measured over this run's 377 Java components, the first request answers in half a
 * second and the rest time out, 318 of them, however slowly they are asked. The poms themselves
 * live on `repo1.maven.org`, which is not the search service and answers every request in about
 * 90ms. So the pom is fetched from there, at a version the export already resolved, and the field
 * is read by the registrar's own `mavenProjectUrl` — the same field, the same parser, the same
 * answer, found without asking a service that will not answer.
 *
 * Versions are tried newest-first until one names a pom that exists, mirroring the registrar's own
 * walk down its version list.
 */
async function mavenHomepage(name, versions) {
    const [groupId, artifactId] = name.split(':');
    for (const version of [...new Set(versions)].sort().reverse()) {
        const url = `https://repo1.maven.org/maven2/${groupId.replaceAll('.', '/')}/${artifactId}/${version}/${artifactId}-${version}.pom`;
        const response = await fetch(url);
        if (response.status === 200) return mavenProjectUrl(await response.text());
    }
    return '';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pool(items, size, worker) {
    const queue = [...items];
    const run = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await worker(next);
    };
    await Promise.all(Array.from({length: Math.max(1, Math.min(size, queue.length))}, run));
}

/** Written whole, the way `jsonCache` writes `libs.json`, but often: this file is a few hundred
 *  kilobytes rather than seventy megabytes, so a checkpoint costs nothing, and a full sweep of a
 *  twelve-repository run is half an hour of requests that must not be lost to one crash. */
function saveHomepages() {
    fs.writeFileSync(homepagesFile, JSON.stringify(homepages, null, 1));
}

async function fetchMissing() {
    if (offline || missing.length === 0) return;
    const byEcosystem = new Map();
    for (const entry of missing) {
        const list = byEcosystem.get(entry[1].ecosystem) || [];
        list.push(entry);
        byEcosystem.set(entry[1].ecosystem, list);
    }
    for (const [ecosystem, entries] of byEcosystem) {
        const registrar = registrarOf.get(ecosystem);
        const delay = DELAY_MS[ecosystem] || 0;
        process.stderr.write(`${ecosystem}: ${entries.length} to fetch\n`);
        let done = 0;
        await pool(entries, CONCURRENCY[ecosystem] ?? 6, async ([key, {name, versions}]) => {
            // One retry, because the failures that matter here are throttling rather than a
            // package the registry has never heard of, and a throttled registry answers the
            // second time.
            for (const attempt of [0, 1]) {
                try {
                    const found = ecosystem === 'java'
                        ? await mavenHomepage(name, versions)
                        : (await registrar.retrieve(name)).homepageUrl;
                    homepages[key] = found || '';
                    counts.fetched++;
                    break;
                } catch (e) {
                    if (attempt === 1) { homepages[key] = null; counts.failed++; }
                    else await sleep(1000);
                }
            }
            if (delay) await sleep(delay);
            if (++done % 100 === 0) {
                saveHomepages();
                process.stderr.write(`  ${ecosystem} ${done}/${entries.length}\n`);
            }
        });
        saveHomepages();
    }
}

fetchMissing().then(() => {
    const changed = {filled: 0, cleared: 0, same: 0, untouched: 0};
    for (const row of rows) {
        const originName = row['Origin name'];
        if (only && !only.has(originName)) { changed.untouched++; continue; }
        const ecosystem = ECOSYSTEM_OF_ORIGIN[originName];
        const key = `${ecosystem}:${row[nameColumn]}`;
        if (!answered(key)) { changed.untouched++; continue; }
        const origin = originFor(PURL_TYPE_OF_ORIGIN[originName] || '', row[nameColumn]);
        const before = row['Component Link'] || '';
        const after = componentLink(origin, row[nameColumn], homepages[key]);
        row['Component Link'] = after;
        if (before === after) changed.same++;
        else if (after) changed.filled++;
        else changed.cleared++;
    }
    fs.writeFileSync(depsFile, stringify(rows, {header: true, columns: Object.keys(rows[0])}));
    console.log({rows: rows.length, ...counts, ...changed});
});
