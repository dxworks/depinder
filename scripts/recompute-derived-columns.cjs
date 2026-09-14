/**
 * Offline recompute of the columns that are derived, not scanned.
 *
 * Reads an existing `export-blackduck` output plus the registry cache that produced it, and
 * rewrites `License names`, `License families`, `License Risk` and `Operational Risk` in
 * `_dependencies.csv` and `_dependencies_sources.csv`. Every other cell is left exactly as it was.
 *
 * This exists so a change to a derivation can be applied to a finished run without re-running
 * `export-blackduck`, which would re-run trivy and grype against today's vulnerability databases
 * and quietly turn one run into a different one. Nothing here touches scanners, registries or the
 * network: the derivations come from `dist/`, so the script cannot drift from the exporter.
 *
 *   node scripts/recompute-derived-columns.cjs CACHE_DIR EXPORT_DIR [--cdx SAVED_CDX_DIR] [--as-of YYYY-MM-DD]
 *
 * `--cdx` points at the run's saved CycloneDX files. With it, the licence a row falls back on is
 * the one the SBOM actually declared -- the same input the exporter read -- instead of the cell
 * already in the file. Without it the cell is still the fallback, and is at least normalised.
 *
 * `--as-of` is the date staleness is measured from; it defaults to the export's own mtime so a
 * rerun on an archived run reproduces the same answer rather than drifting with today's date.
 */
const fs = require('fs');
const path = require('path');
const {parse, stringify} = require('csv/sync');
const {licenseColumns, licenseColumnsFromNames, licenseRisk, licenseRiskFromNames, hasKnownLicense} = require('../dist/blackduck/licenses');
const {operationalRisk} = require('../dist/blackduck/risk');

const args = process.argv.slice(2);
const flag = args.indexOf('--as-of');
const asOfArg = flag === -1 ? null : args[flag + 1];
const cdxFlag = args.indexOf('--cdx');
const cdxDir = cdxFlag === -1 ? null : args[cdxFlag + 1];
const consumed = new Set();
for (const at of [flag, cdxFlag]) if (at !== -1) consumed.add(at), consumed.add(at + 1);
const [cacheDir, exportDir] = args.filter((it, i) => !consumed.has(i));
if (!cacheDir || !exportDir) {
    throw new Error('Usage: node scripts/recompute-derived-columns.cjs CACHE_DIR EXPORT_DIR [--cdx SAVED_CDX_DIR] [--as-of YYYY-MM-DD]');
}

const depsFile = path.join(exportDir, '_dependencies.csv');
const asOf = asOfArg ? new Date(asOfArg) : fs.statSync(depsFile).mtime;
if (Number.isNaN(asOf.getTime())) throw new Error(`not a date: ${asOfArg}`);

/**
 * The cache is keyed `<ecosystem>:<name>`, the CSVs carry a registry origin. Same fact, two
 * vocabularies. A name is looked up under its own origin's ecosystem first; the fallback to any
 * ecosystem is for the origins that map to no single cache prefix (`unknown`, `long_tail`).
 */
const ECOSYSTEM_OF_ORIGIN = {
    npmjs: 'npm', rubygems: 'ruby', packagist: 'php', pypi: 'python',
    nuget: 'dotnet', github: 'go', maven: 'java', crates: 'rust',
};

/**
 * The licence each component declares in the run's own SBOMs, keyed the way the CSVs are.
 *
 * This is the exporter's other input, and the one the cell in the file was built from in the first
 * place -- reading it back is how a row with no cache entry gets its licence from the same source
 * a real export would have used, rather than from a cell somebody has to hope is right.
 */
function sbomLicenses(dir) {
    const {parsePurl} = require('../dist/plugins/sbom/cyclonedx');
    const {originFor, originId} = require('../dist/blackduck/origins');
    const byId = new Map();
    for (const file of fs.readdirSync(dir).filter(it => it.endsWith('.cdx.json')).sort()) {
        const bom = JSON.parse(fs.readFileSync(path.join(dir, file)));
        for (const component of bom.components || []) {
            if (!component.purl) continue;
            const parsed = parsePurl(component.purl);
            if (!parsed || !parsed.name || !parsed.version) continue;
            // CycloneDX writes a compound expression in `expression`, a sibling of `license` --
            // reading only `license` drops every `A OR B`.
            const declared = (component.licenses || [])
                .map(it => (it && it.license && (it.license.id || it.license.name)) || (it && it.expression))
                .filter(it => typeof it === 'string' && it.trim());
            if (declared.length === 0) continue;
            const origin = originFor(parsed.type, parsed.name);
            const id = originId(origin, parsed.name, parsed.version);
            // The same package appears under several bom-refs when it was found in several
            // locations, and the copies do not always agree: keep whichever one knows a licence.
            if (!byId.has(id)) byId.set(id, declared);
        }
    }
    return byId;
}

const fromSbom = cdxDir ? sbomLicenses(cdxDir) : new Map();
const cache = JSON.parse(fs.readFileSync(path.join(cacheDir, 'libs.json')));
const byKey = new Map(Object.entries(cache));
const byName = new Map();
for (const entry of Object.values(cache)) {
    const name = entry.name;
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(entry);
}

/**
 * The licence the resolved VERSION declares, or nothing.
 *
 * Only the version-level field is read, and only to correct the one thing the exporter got wrong:
 * preferring the library-level licence, which reports the package's current licence and so
 * relicenses every older version. The library-level fallback is deliberately NOT reproduced here,
 * because the cell already in the file is a better fallback than this script can build -- the
 * exporter also reads the SBOM, which this script has not got. Returning nothing means "leave the
 * cell alone", and an id the licence table cannot map counts as nothing for the same reason the
 * exporter skips it: a cell already holding a readable licence is not improved by `BSD-like`.
 */
function versionLicensesFor(name, version, originName) {
    const ecosystem = ECOSYSTEM_OF_ORIGIN[originName];
    const candidates = [];
    if (ecosystem && byKey.has(`${ecosystem}:${name}`)) candidates.push(byKey.get(`${ecosystem}:${name}`));
    for (const it of byName.get(name) || []) if (!candidates.includes(it)) candidates.push(it);
    for (const entry of candidates) {
        const current = (entry.versions || []).find(it => it.version === version);
        const licenses = flatten(current && current.licenses);
        if (licenses.length > 0 && hasKnownLicense(licenses)) return licenses;
    }
    return [];
}

function flatten(value) {
    const out = [];
    for (const it of Array.isArray(value) ? value : [value]) {
        if (typeof it === 'string' && it.trim()) out.push(it);
    }
    return out;
}

const counts = {rows: 0, licenceCorrected: 0, licenceFromSbom: 0, licenceNormalised: 0, riskFromIds: 0, riskFromCell: 0, opFilled: 0, opUnknown: 0};

function recompute(file, nameColumn) {
    const full = path.join(exportDir, file);
    if (!fs.existsSync(full)) return;
    const rows = parse(fs.readFileSync(full), {columns: true});
    if (rows.length === 0) return;
    for (const row of rows) {
        counts.rows++;
        const licenses = versionLicensesFor(row[nameColumn], row['Component version name'], row['Origin name']);
        if (licenses.length > 0) {
            const {names, families} = licenseColumns(licenses);
            if (row['License names'] !== names) counts.licenceCorrected++;
            row['License names'] = names;
            row['License families'] = families;
            row['License Risk'] = licenseRisk(licenses);
            counts.riskFromIds++;
        } else {
            // No cache entry for this version. The SBOM's own declaration is the next best input,
            // because it is an input the exporter read; failing that, the cell already in the file
            // is all there is. Either way it goes through the exporter's own reader, which
            // resolves a written name as readily as an SPDX id -- so `Apache License, Version 2.0`
            // becomes `Apache License 2.0` here for the same reason it would have at export time.
            const declared = fromSbom.get(row['Component Version Origin Id']) || [];
            const readable = declared.length > 0 && hasKnownLicense(declared);
            if (readable) counts.licenceFromSbom++;
            const {names, families} = readable
                ? licenseColumns(declared)
                : licenseColumnsFromNames(row['License names'] || '');
            if (row['License names'] !== names) counts.licenceNormalised++;
            row['License names'] = names;
            row['License families'] = families;
            row['License Risk'] = licenseRiskFromNames(names);
            counts.riskFromCell++;
        }
        row['Operational Risk'] = operationalRisk(row['Release Date'] || '', row['Newer Versions'] || '', asOf);
        if (row['Operational Risk']) counts.opFilled++; else counts.opUnknown++;
    }
    fs.writeFileSync(full, stringify(rows, {header: true, columns: Object.keys(rows[0])}));
}

recompute('_dependencies.csv', '1Component name');
recompute('_dependencies_sources.csv', 'Component name');
console.log({asOf: asOf.toISOString().slice(0, 10), ...counts});
