/** Offline graph/path rebuild. Reads saved CDX and existing enrichment CSVs only. */
const fs = require('fs');
const {createHash} = require('crypto');
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const path = require('path');
const {parse, stringify} = require('csv/sync');
const {sbomTree} = require('../dist/blackduck/paths');
const {parsePurl} = require('../dist/plugins/sbom/cyclonedx');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/rebuild-saved-graphs.cjs SAVED_CDX_DIR EXISTING_EXPORT_DIR');
const read = name => parse(fs.readFileSync(path.join(output, name)), {columns: true});
const write = (name, rows, columns) => fs.writeFileSync(path.join(output, name), stringify(rows, {header: true, columns}));
const sources = read('_dependencies_sources.csv');
const dependencies = read('_dependencies.csv');
const metadata = new Map(sources.map(r => [r['Origin name']+'|'+r['Component Version Origin Id'], r]));
const byCoordinate = new Map(sources.map(r => [r['Component name']+'|'+r['Component version name']+'|'+r['Origin name'], r]));
const {originFor, originId} = require('../dist/blackduck/origins');
const edges = [], paths = [], missing = [], inputs = {};
let rawArcs = 0;
for (const name of fs.readdirSync(input).filter(n => n.endsWith('.cdx.json')).sort()) {
  const file = path.join(input, name), bom = JSON.parse(fs.readFileSync(file));
  inputs[name] = hash(file);
  rawArcs += (bom.dependencies || []).reduce((n,r)=>n+(r.dependsOn||[]).length,0);
  const types = new Set((bom.components || []).map(c => c.purl && parsePurl(c.purl)?.type).filter(t => ['npm','maven','gem','pypi','composer','nuget','cargo','golang'].includes(t)));
  const graph = sbomTree(file, name.replace(/\.(trivy\.)?cdx\.json$/, ''), types);
  edges.push(...graph.edges);
  for (const p of graph.paths) {
    const origin = originFor(p.purlType, p.name), id = originId(origin, p.name, p.version);
    const old = metadata.get(origin.name+'|'+id) || byCoordinate.get(p.name+'|'+p.version+'|'+origin.name);
    if (!old) missing.push(id);
    const saved = old || {...Object.fromEntries(Object.keys(sources[0]).map(k=>[k,''])), 'Component name':p.name,'Component version name':p.version,'Component Version Origin Id':id,'Origin name':origin.name};
    paths.push({...saved, Path: p.path, ProjectPath: p.projectPath, 'Match type': p.matchType});
  }
}
const typesById = new Map();
for (const p of paths) {const id=p['Component Version Origin Id']; const s=typesById.get(id)||new Set();s.add(p['Match type']);typesById.set(id,s);}
for (const d of dependencies) {const t=typesById.get(d['Component Version Origin Id']); if(t)d['Match type']=['Direct Dependency','Transitive Dependency'].filter(x=>t.has(x)).join(',');}
write('_dependency_edges.csv', edges.map(e => ({Repo:e.repo,Tree:e.tree,Ecosystem:e.purlType,'Parent Origin Id':e.parent,'Child Origin Id':e.child,'Child Depth':e.depth})),['Repo','Tree','Ecosystem','Parent Origin Id','Child Origin Id','Child Depth']);
write('_dependencies_sources.csv',paths,Object.keys(sources[0]));
write('_dependencies.csv',dependencies,Object.keys(dependencies[0]));
fs.writeFileSync(path.join(output,'_graph_rebuild.json'),JSON.stringify({mode:'offline',inputs,rawArcs,transform:hash(path.join(__dirname,'../dist/blackduck/paths.js')),parser:hash(path.join(__dirname,'../dist/plugins/sbom/cyclonedx.js')),edges:edges.length,paths:paths.length,pathsWithoutSavedEnrichment:[...new Set(missing)].sort(),rootSemantics:'declared where anchored; otherwise inferred graph entry points, not confirmed direct declarations'},null,2)+'\n');
console.log({edges:edges.length,paths:paths.length,pathsWithoutSavedEnrichment:new Set(missing).size});
