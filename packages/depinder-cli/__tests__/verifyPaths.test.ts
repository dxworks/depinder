import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { createVerifyPathsCommand } from '../src/commands/verifyPaths';
import { createTransformBlackDuckReportsCommand } from '../src/commands/transformBlackDuckReports';
import { csvLines } from '../src/utils/csv';

let folder: string;
let checkout: string;
let reports: string;

function write(relativePath: string, content: string): string {
    const target = path.join(folder, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
}

function readSources(reportDir = reports): Record<string, string>[] {
    return parse(fs.readFileSync(path.join(reportDir, '_dependencies_sources.csv'), 'utf8'), { columns: true });
}

function verify(reportDir = reports, ...options: string[]) {
    return createVerifyPathsCommand().parseAsync([reportDir, '-b', checkout, ...options], { from: 'user' });
}

function rawReports(sourcePaths = ['repo/-npm/library/1']): void {
    write('reports/components_test.csv', csvLines([
        ['Component name', 'Component version name', 'Version id'],
        ...sourcePaths.map((_, index) => ['library', '1', String(index)])
    ]));
    write('reports/source_test.csv', csvLines([
        ['Component name', 'Component version name', 'Version id', 'Origin name id', 'Origin name', 'Path'],
        ...sourcePaths.map((sourcePath, index) => ['library', '1', String(index), 'library/1', 'npmjs', sourcePath])
    ]));
    write('reports/security_test.csv', 'Component name\n');
    write('reports/project_version_upgrade_guidance_test.csv', 'Component Name\n');
}

function transform(...options: string[]) {
    return createTransformBlackDuckReportsCommand().parseAsync([reports, ...options], { from: 'user' });
}

beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-verify-'));
    checkout = path.join(folder, 'checkout');
    reports = path.join(folder, 'reports');
    fs.mkdirSync(checkout);
});

afterEach(() => {
    vi.restoreAllMocks();
    if (path.dirname(folder) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('depinder-verify-')) {
        throw new Error(`Unexpected test cleanup path: ${folder}`);
    }
    fs.rmSync(folder, { recursive: true, force: true });
});

it('verifies authoritative ProjectPath while preserving columns, values, row order and duplicate rows', async () => {
    fs.mkdirSync(path.join(checkout, 'repo/api'), { recursive: true });
    const raw = 'ProjectFilePath,Custom,VerifiedPathMethod,Path,ProjectPath,VerifiedPath\r\n'
        + 'repo/api/package.json," \tvalue, with ""quotes""\nand newline ",not-checked,unparseable,repo/api,\r\n'
        + 'repo/api/package.json," \tvalue, with ""quotes""\nand newline ",not-checked,unparseable,repo/api,\r\n';
    write('reports/_dependencies_sources.csv', raw);
    write('reports/_dependencies.csv', 'untouched dependency report');
    write('reports/_dependencies_sources_by_category.csv', 'untouched source categories');
    write('reports/_dependencies_by_category.csv', 'untouched dependency categories');
    write('reports/_upgrade_guidance.csv', 'untouched upgrades');
    write('reports/_vulnerability_details.csv', 'untouched vulnerabilities');

    await verify();

    expect(readSources()).toEqual([
        {
            ProjectFilePath: 'repo/api/package.json', Custom: ' \tvalue, with "quotes"\nand newline ',
            VerifiedPathMethod: 'exact', Path: 'unparseable', ProjectPath: 'repo/api', VerifiedPath: 'repo/api'
        },
        {
            ProjectFilePath: 'repo/api/package.json', Custom: ' \tvalue, with "quotes"\nand newline ',
            VerifiedPathMethod: 'exact', Path: 'unparseable', ProjectPath: 'repo/api', VerifiedPath: 'repo/api'
        }
    ]);
    expect(Object.keys(readSources()[0])).toEqual([
        'ProjectFilePath', 'Custom', 'VerifiedPathMethod', 'Path', 'ProjectPath', 'VerifiedPath'
    ]);
    expect(fs.readFileSync(path.join(reports, '_dependencies.csv'), 'utf8')).toBe('untouched dependency report');
    expect(fs.readFileSync(path.join(reports, '_dependencies_sources_by_category.csv'), 'utf8')).toBe('untouched source categories');
    expect(fs.readFileSync(path.join(reports, '_dependencies_by_category.csv'), 'utf8')).toBe('untouched dependency categories');
    expect(fs.readFileSync(path.join(reports, '_upgrade_guidance.csv'), 'utf8')).toBe('untouched upgrades');
    expect(fs.readFileSync(path.join(reports, '_vulnerability_details.csv'), 'utf8')).toBe('untouched vulnerabilities');
});

it('rechecks previously verified rows and clears results when their checkout disappears', async () => {
    fs.mkdirSync(path.join(checkout, 'repo'));
    write('reports/_dependencies_sources.csv', 'ProjectPath,VerifiedPath,VerifiedPathMethod\nrepo,stale,mapping\n');
    await verify();
    expect(readSources()[0]).toMatchObject({ VerifiedPath: 'repo', VerifiedPathMethod: 'exact' });
    fs.renameSync(path.join(checkout, 'repo'), path.join(checkout, 'moved'));

    await verify();

    expect(readSources()[0]).toEqual({ ProjectPath: 'repo', VerifiedPath: '', VerifiedPathMethod: 'none' });
});

it('discovers direct, trivy and syft reports without traversing other or nested directories', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fs.mkdirSync(path.join(checkout, 'repo'));
    const raw = 'ProjectPath\nrepo\nmissing\n';
    write('reports/_dependencies_sources.csv', raw);
    write('reports/trivy/_dependencies_sources.csv', raw);
    write('reports/syft/_dependencies_sources.csv', raw);
    const other = write('reports/other/_dependencies_sources.csv', raw);
    const nested = write('reports/trivy/trivy/_dependencies_sources.csv', raw);

    await verify();

    expect(readSources().map(row => row.VerifiedPathMethod)).toEqual(['exact', 'none']);
    expect(readSources(path.join(reports, 'trivy')).map(row => row.VerifiedPathMethod)).toEqual(['exact', 'none']);
    expect(readSources(path.join(reports, 'syft')).map(row => row.VerifiedPathMethod)).toEqual(['exact', 'none']);
    expect(fs.readFileSync(other, 'utf8')).toBe(raw);
    expect(fs.readFileSync(nested, 'utf8')).toBe(raw);
    expect(log.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
        `Verified paths in ${reports}: 1 verified, 1 unverified, 2 total.`,
        `Verified paths in ${path.join(reports, 'trivy')}: 1 verified, 1 unverified, 2 total.`,
        `Verified paths in ${path.join(reports, 'syft')}: 1 verified, 1 unverified, 2 total.`
    ]));
});

it.each(['', 'ProjectPath,VerifiedPath,VerifiedPathMethod\r\n'])(
    'leaves empty report %j unchanged, including when only one scanner folder exists', async raw => {
        const target = write('reports/trivy/_dependencies_sources.csv', raw);

        await verify();

        expect(fs.readFileSync(target, 'utf8')).toBe(raw);
    }
);

it('refreshes both category reports after verification when --repoCategories is supplied', async () => {
    fs.mkdirSync(path.join(checkout, 'actual/api'), { recursive: true });
    const mapping = write('mappings.json', JSON.stringify({ pathMappings: [{ extractedPath: 'old/api', actualPath: 'actual/api' }] }));
    const categories = write('categories.csv', 'repo,category\nactual,Backend\n');
    write('reports/_dependencies_sources.csv', 'Component Version Origin Id,Version id,ProjectPath,ProjectFilePath,VerifiedPath\nlib/1,,old/api,old/api/pom.xml,stale\n');
    const dependencies = 'Component Version Origin Id,Version id,Component name\nlib/1,,library\n';
    write('reports/_dependencies.csv', dependencies);
    write('reports/_dependencies_sources_by_category.csv', 'old source categories');
    write('reports/_dependencies_by_category.csv', 'old dependency categories');

    await verify(reports, '--pathMappings', mapping, '--repoCategories', categories);

    expect(readSources()[0]).toMatchObject({ ProjectPath: 'old/api', VerifiedPath: 'actual/api', VerifiedPathMethod: 'mapping' });
    const sourcesByCategory = parse(fs.readFileSync(path.join(reports, '_dependencies_sources_by_category.csv'), 'utf8'), { columns: true });
    const dependenciesByCategory = parse(fs.readFileSync(path.join(reports, '_dependencies_by_category.csv'), 'utf8'), { columns: true });
    expect(sourcesByCategory).toEqual([
        expect.objectContaining({ Repository: 'actual', Category: 'Backend', VerifiedPath: 'actual/api', ProjectFilePath: 'old/api/pom.xml' })
    ]);
    expect(dependenciesByCategory).toEqual([
        { Category: 'Backend', 'Component Version Origin Id': 'lib/1', 'Version id': '', 'Component name': 'library' }
    ]);
    expect(fs.readFileSync(path.join(reports, '_dependencies.csv'), 'utf8')).toBe(dependencies);
});

it.each([
    ['missing base', '--basePath', 'absent', undefined],
    ['base is a file', '-b', 'bad-base', 'file'],
    ['missing mapping', '-m', 'absent.json', undefined],
    ['broken JSON mapping', '--pathMappings', 'bad.json', '{'],
    ['missing mapping array', '-m', 'bad.json', '{}'],
    ['invalid mapping entry', '-m', 'bad.json', '{"pathMappings":[{"extractedPath":"old","actualPath":7}]}'],
    ['empty mapping entry', '-m', 'bad.json', '{"pathMappings":[{"extractedPath":"old","actualPath":""}]}'],
    ['missing categories', '--repoCategories', 'absent.csv', undefined],
    ['malformed categories', '--repoCategories', 'bad.csv', 'repo,wrong\n'],
    ['empty categories', '--repoCategories', 'bad.csv', ''],
    ['invalid category entry', '--repoCategories', 'bad.csv', 'repo,category\nrepo,\n']
])('rejects %s without changing reports in either command', async (_, flag, relativePath, content) => {
    rawReports();
    const original = 'ProjectPath,VerifiedPath,VerifiedPathMethod\nrepo,old,exact\n';
    const target = write('reports/_dependencies_sources.csv', original);
    const dependencyTarget = write('reports/_dependencies.csv', 'existing dependencies');
    const optionPath = content === undefined ? path.join(folder, relativePath) : write(relativePath, content);

    await expect(verify(reports, flag, optionPath)).rejects.toThrow();
    await expect(transform('-b', checkout, flag, optionPath)).rejects.toThrow();

    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.readFileSync(dependencyTarget, 'utf8')).toBe('existing dependencies');
});

it.each([
    'WrongColumn\nrepo\n',
    'ProjectPath,ProjectPath\nrepo,repo\n',
    'ProjectPath,VerifiedPath\nrepo\n',
    'ProjectPath\n"unterminated\n'
])('rejects invalid source report %j before writing any discovered folder', async invalid => {
    const original = 'ProjectPath,VerifiedPath,VerifiedPathMethod\nrepo,stale,mapping\n';
    const validTarget = write('reports/trivy/_dependencies_sources.csv', original);
    const invalidTarget = write('reports/syft/_dependencies_sources.csv', invalid);
    fs.mkdirSync(path.join(checkout, 'repo'));

    await expect(verify()).rejects.toThrow();

    expect(fs.readFileSync(validTarget, 'utf8')).toBe(original);
    expect(fs.readFileSync(invalidTarget, 'utf8')).toBe(invalid);
});

it('rejects invalid category report inputs before changing verification results', async () => {
    fs.mkdirSync(path.join(checkout, 'repo'));
    const original = 'ProjectPath,Component Version Origin Id\nrepo,lib/1\n';
    const target = write('reports/_dependencies_sources.csv', original);
    write('reports/_dependencies.csv', 'Component Version Origin Id\n""\n');
    const categories = write('categories.csv', 'repo,category\nrepo,Backend\n');

    await expect(verify(reports, '--repoCategories', categories)).rejects.toThrow('empty Component Version Origin Id');

    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(reports, '_dependencies_by_category.csv'))).toBe(false);
});

it('fails when no reports are found', async () => {
    fs.mkdirSync(reports);

    await expect(verify()).rejects.toThrow('No _dependencies_sources.csv found');
});

it('requires --basePath for standalone verification', async () => {
    const command = createVerifyPathsCommand().exitOverride().configureOutput({ writeErr: () => {} });

    await expect(command.parseAsync([reports], { from: 'user' })).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
});

it('keeps optional verification in transform, then produces identical results through standalone verification', async () => {
    rawReports([
        'exact/-npm/library/1',
        'old/-npm/library/1',
        'org.example:artifact:1.0:repo/services/artifact:-maven/org.other:dependency:1',
        'prefix/module/-npm/library/1',
        'missing/-npm/library/1',
        'prefix/blocked/-npm/library/1',
        'org.example:other:1.0:repo/services/missing:-maven/org.other:dependency:1'
    ]);
    fs.mkdirSync(path.join(checkout, 'exact'));
    fs.mkdirSync(path.join(checkout, 'relocated'));
    fs.mkdirSync(path.join(checkout, 'repo/services'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'module'));
    fs.mkdirSync(path.join(checkout, 'blocked'));
    const mappings = write('mappings.json', JSON.stringify({ pathMappings: [
        { extractedPath: 'exact', actualPath: 'relocated' },
        { extractedPath: 'old', actualPath: 'relocated' },
        { extractedPath: 'prefix/blocked', actualPath: 'absent' }
    ] }));
    const categories = write('categories.csv', 'repo,category\nexact,A\nrelocated,B\nrepo,C\nmodule,D\n');
    await transform();
    expect(readSources().map(row => row.VerifiedPathMethod)).toEqual(Array(7).fill('not-checked'));
    const unverified = fs.readFileSync(path.join(reports, '_dependencies_sources.csv'), 'utf8');

    await transform('--basePath', checkout, '-m', mappings, '--repoCategories', categories);
    const transformed = fs.readFileSync(path.join(reports, '_dependencies_sources.csv'), 'utf8');
    const transformedCategories = fs.readFileSync(path.join(reports, '_dependencies_sources_by_category.csv'), 'utf8');
    expect(readSources().map(row => [row.VerifiedPath, row.VerifiedPathMethod])).toEqual([
        ['exact', 'exact'], ['relocated', 'mapping'], ['repo/services', 'maven-artifact-parent'],
        ['module', 'drop-first-segment'], ['', 'none'], ['', 'none'], ['', 'none']
    ]);
    write('reports/_dependencies_sources.csv', unverified);
    await verify(reports, '-m', mappings, '--repoCategories', categories);

    expect(fs.readFileSync(path.join(reports, '_dependencies_sources.csv'), 'utf8')).toBe(transformed);
    expect(fs.readFileSync(path.join(reports, '_dependencies_sources_by_category.csv'), 'utf8')).toBe(transformedCategories);
});

it('rejects malformed upgrade guidance before transform overwrites existing outputs', async () => {
    rawReports();
    write('reports/project_version_upgrade_guidance_test.csv', 'Component Name\n"unterminated\n');
    const original = 'existing source report';
    const target = write('reports/_dependencies_sources.csv', original);

    await expect(transform()).rejects.toThrow('Quote Not Closed');

    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(reports, '_dependencies.csv'))).toBe(false);
});
