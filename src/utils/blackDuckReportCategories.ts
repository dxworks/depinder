import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const CSV_PARSE_OPTIONS = {
    columns: (headers: string[]) => headers.map(header => header.trim()),
    skip_empty_lines: true,
    trim: true
} as const;

const DEPENDENCIES_FILE = '_dependencies.csv';
const DEPENDENCIES_SOURCES_FILE = '_dependencies_sources.csv';
const DEPENDENCIES_BY_CATEGORY_FILE = '_dependencies_by_category.csv';
const DEPENDENCIES_SOURCES_BY_CATEGORY_FILE = '_dependencies_sources_by_category.csv';
const JOIN_KEY = 'Version id';

export const COULD_NOT_MAP_REPOSITORY_CATEGORY = 'COULD_NOT_MAP_REPOSITORY';

type CsvRecord = Record<string, string>;

interface CategoryOutputs {
    dependenciesByCategory: CsvRecord[];
    dependenciesSourcesByCategory: CsvRecord[];
}

export async function addCategoriesToBlackDuckReports(reportDir: string, repoCategoriesPath: string): Promise<void> {
    const dependenciesRaw = await fs.readFile(path.join(reportDir, DEPENDENCIES_FILE), 'utf-8');
    const dependenciesSourcesRaw = await fs.readFile(path.join(reportDir, DEPENDENCIES_SOURCES_FILE), 'utf-8');
    const repoCategoriesRaw = await fs.readFile(repoCategoriesPath, 'utf-8');

    const dependencies = parseCsv(dependenciesRaw);
    const dependenciesSources = parseCsv(dependenciesSourcesRaw);
    const repoCategories = parseRepoCategories(repoCategoriesRaw);

    const outputs = addCategoriesToReports(dependencies, dependenciesSources, repoCategories);

    await fs.writeFile(
        path.join(reportDir, DEPENDENCIES_SOURCES_BY_CATEGORY_FILE),
        stringify(outputs.dependenciesSourcesByCategory, { header: true })
    );
    await fs.writeFile(
        path.join(reportDir, DEPENDENCIES_BY_CATEGORY_FILE),
        stringify(outputs.dependenciesByCategory, { header: true })
    );
}

export function addCategoriesToReports(
    dependencies: CsvRecord[],
    dependenciesSources: CsvRecord[],
    repoCategories: Map<string, string>
): CategoryOutputs {
    validateJoinKeys(dependencies, DEPENDENCIES_FILE);
    validateJoinKeys(dependenciesSources, DEPENDENCIES_SOURCES_FILE);

    const dependenciesSourcesByCategory = dependenciesSources.map(row => {
        const repository = getRepository(row['VerifiedPath'] || '');
        const category = getCategory(repository, repoCategories);

        return {
            Repository: repository,
            Category: category,
            ...row
        };
    });

    const categoriesByOriginId = buildCategoriesByOriginId(dependenciesSourcesByCategory);
    const dependenciesByCategory = dependencies.flatMap(row => {
        const categories = categoriesByOriginId.get(row[JOIN_KEY]) || [''];

        return categories.map(category => ({
            Category: category,
            ...row
        }));
    });

    return {
        dependenciesByCategory,
        dependenciesSourcesByCategory
    };
}

export function parseRepoCategories(raw: string): Map<string, string> {
    const rows = parse(raw, CSV_PARSE_OPTIONS) as CsvRecord[];
    const repoCategories = new Map<string, string>();

    for (const row of rows) {
        const repo = row.repo?.trim() || '';
        const category = row.category?.trim() || '';

        if (!repo) {
            throw new Error('repo-to-category.csv contains an empty repo value');
        }
        if (!category) {
            throw new Error(`repo-to-category.csv contains an empty category for repo: ${repo}`);
        }

        const repoKey = normalizeRepo(repo);
        if (repoCategories.has(repoKey)) {
            throw new Error(`repo-to-category.csv contains duplicate repo: ${repo}`);
        }

        repoCategories.set(repoKey, category);
    }

    return repoCategories;
}

function parseCsv(raw: string): CsvRecord[] {
    return parse(raw, CSV_PARSE_OPTIONS) as CsvRecord[];
}

function validateJoinKeys(rows: CsvRecord[], fileName: string): void {
    const firstInvalidRow = rows.findIndex(row => !(row[JOIN_KEY] || '').trim());
    if (firstInvalidRow >= 0) {
        throw new Error(`${fileName} contains an empty ${JOIN_KEY} at data row ${firstInvalidRow + 1}`);
    }
}

function buildCategoriesByOriginId(rows: CsvRecord[]): Map<string, string[]> {
    const categoriesByOriginId = new Map<string, Set<string>>();

    for (const row of rows) {
        const category = row.Category || '';
        if (!category) {
            continue;
        }

        const originId = row[JOIN_KEY];
        if (!categoriesByOriginId.has(originId)) {
            categoriesByOriginId.set(originId, new Set<string>());
        }
        categoriesByOriginId.get(originId)!.add(category);
    }

    return new Map(
        [...categoriesByOriginId.entries()].map(([originId, categories]) => [
            originId,
            [...categories].sort((a, b) => a.localeCompare(b))
        ])
    );
}

function getCategory(repository: string, repoCategories: Map<string, string>): string {
    if (!repository) {
        return '';
    }

    return repoCategories.get(normalizeRepo(repository)) || COULD_NOT_MAP_REPOSITORY_CATEGORY;
}

function getRepository(verifiedPath: string): string {
    const normalizedPath = verifiedPath.trim().replace(/\\/g, '/');
    return normalizedPath.split('/').find(segment => segment.length > 0) || '';
}

function normalizeRepo(repo: string): string {
    return repo.trim().toLowerCase();
}
