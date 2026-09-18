import fs from 'fs/promises';
import * as fsSync from 'fs';
import path from 'path';
import { Command } from 'commander';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { extractProjectInfo, PathMappings, createPathMappings } from '../utils/projectMapping';
import { addCategoriesToBlackDuckReports } from '../utils/blackDuckReportCategories';
import {
    blackDuckDateToTabIso,
    countCell,
    DEPENDENCIES_COLUMNS,
    DEPENDENCIES_SOURCES_COLUMNS,
    normalizeMatchType,
    VULNERABILITY_DETAILS_COLUMNS
} from '../blackduck/columns';

/**
 * Common options for CSV parsing
 */
const CSV_PARSE_OPTIONS = { columns: true, skip_empty_lines: true } as const;

/**
 * Interface representing a raw component record from Black Duck
 */
interface ComponentRecord {
    [key: string]: string;
    'Component name': string;
    'Component version name': string;
    'License names': string;
    'License families': string;
    'Match type': string;
    'Usage': string;
    'Operational Risk': string;
    'License Risk': string;
    'Critical Vulnerability Count': string;
    'High Vulnerability Count': string;
    'Medium Vulnerability Count': string;
    'Low Vulnerability Count': string;
    'Release Date': string;
    'Newer Versions': string;
    'Open Hub URL': string;
    'Version id': string;
}

/**
 * Interface representing a raw source record from Black Duck
 */
interface SourceRecord {
    [key: string]: string;
    'Component name': string;
    'Component version name': string;
    'Match type': string;
    'Path': string;
    'Origin name': string;
    'Version id': string;
}

/**
 * Interface representing a raw security record from Black Duck
 */
interface SecurityRecord {
    [key: string]: string;
}

/** The four output shapes live in `blackduck/columns.ts`, shared with `export-blackduck`. */
const DEPENDENCIES_COLUMN_ORDER = DEPENDENCIES_COLUMNS;
const DEPENDENCIES_SOURCES_COLUMN_ORDER = DEPENDENCIES_SOURCES_COLUMNS;
const VULNERABILITY_DETAILS_HEADERS = VULNERABILITY_DETAILS_COLUMNS;

/**
 * Columns to remove from upgrade guidance CSV
 */
const UPGRADE_GUIDANCE_COLUMNS_TO_REMOVE = new Set([
    'Used by',
    'Component Id',
    'Component Version Id',
    'Component Origin Id',
    'Component Origin Version Name',
    'Short Term Recommended Version Id',
    'Long Term Recommended Version Id',
    'Short Term Recommended Component Origin Id',
    'Long Term Recommended Component Origin Id',
    'Knowledgebase Timed Out'
]);

/**
 * Interface for vulnerability counts
 */
interface VulnerabilityCounts {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
    criticalAndHigh: number;
}

/**
 * Safely parses a string to an integer, returning 0 for invalid inputs
 * @param s String to parse
 * @returns Parsed integer or 0 if invalid
 */
function safeInt(s?: string): number {
    const v = parseInt(s ?? '', 10);
    return isNaN(v) ? 0 : v;
}

/** Black Duck's `M/D/YY` → `\tYYYY-MM-DD`; see `blackduck/columns.ts`. */
const formatDateField = blackDuckDateToTabIso;

/**
 * Normalizes values to string format according to Black Duck report requirements
 * @param val Value to normalize
 * @returns Normalized string value
 */
function normalizeValue(val: unknown): string {
    if (val === true) return 'TRUE';
    if (val === false) return 'FALSE';
    if (val === null || val === undefined) return '';
    if (typeof val === 'number') return `${val}`;
    return `${val}`.trim();
}

/**
 * Calculates vulnerability counts from a component record
 * @param component Component record
 * @returns Object with vulnerability counts
 */
function calculateVulnerabilityCounts(component: ComponentRecord): VulnerabilityCounts {
    const critical = safeInt(component['Critical Vulnerability Count']);
    const high = safeInt(component['High Vulnerability Count']);
    const medium = safeInt(component['Medium Vulnerability Count']);
    const low = safeInt(component['Low Vulnerability Count']);

    return {
        critical,
        high,
        medium,
        low,
        total: critical + high + medium + low,
        criticalAndHigh: critical + high
    };
}

/**
 * Collapses a potentially comma-separated origin-name list to its distinct values.
 *
 * A single component can legitimately be matched in more than one ecosystem when the Black Duck
 * project version spans several package managers (e.g. the same name on `npmjs` and `packagist`).
 * That is data, not an error, so the distinct origins are preserved joined by `;` rather than
 * aborting the whole transform.
 *
 * @param originName Origin name string that might contain multiple comma-separated values
 * @returns The single origin name, or the distinct origins joined by `;`
 */
function getSingleOriginName(originName: string): string {
    if (!originName) {
        return '';
    }

    const origins = originName.split(',').map(origin => origin.trim()).filter(origin => origin.length > 0);

    return [...new Set(origins)].join(';');
}

/**
 * Transforms components data into dependencies records
 * @param components Raw component records from Black Duck
 * @returns Transformed dependency records
 */
function transformDependencies(components: ComponentRecord[]): Record<string, string>[] {
    return components.map(component => {
        const counts = calculateVulnerabilityCounts(component);

        const result: Record<string, string> = {
            'Component name': component['Component name'],
            'Component version name': component['Component version name'],
            'Version id': component['Version id'],
            'Component Version Origin Id': component['Origin id'] || '',
            'License names': component['License names'],
            'License families': component['License families'],
            'Match type': normalizeMatchType(component['Match type']),
            'Usage': component['Usage'],
            'Operational Risk': component['Operational Risk'],
            'License Risk': component['License Risk'],
            'Total Vulnerability Count': `${counts.total}`,
            'Critical and High Vulnerability Count': `${counts.criticalAndHigh}`,
            'Critical Vulnerability Count': countCell(counts.critical),
            'High Vulnerability Count': countCell(counts.high),
            'Medium Vulnerability Count': countCell(counts.medium),
            'Low Vulnerability Count': countCell(counts.low),
            'Release Date': formatDateField(component['Release Date']),
            'Newer Versions': component['Newer Versions'],
            'Open Hub URL': component['Open Hub URL']
        };

        // Handle optional fields
        result['Origin name'] = getSingleOriginName(component['Origin name'] || '');
        result['Commit Activity'] = component['Commit Activity'] || '';
        result['Commits in Past 12 Months'] = component['Commits in Past 12 Months'] || '';
        result['Contributors in Past 12 Months'] = component['Contributors in Past 12 Months'] || '';
        result['Has License Conflicts'] = component['Has License Conflicts'] || '';
        result['Component Link'] = component['Component Link'] || '';

        return result;
    });
}

/**
 * Transforms sources and components data into dependencies_sources records
 * @param sources Raw source records from Black Duck
 * @param components Raw component records from Black Duck
 * @param basePath Optional base path for verifying project paths
 * @returns Transformed dependency source records
 */
function transformDependenciesSources(
    sources: SourceRecord[],
    components: ComponentRecord[],
    basePath?: string,
    pathMappings?: PathMappings
): Record<string, string>[] {
    const validSources = sources.filter(src =>
        components.some(c => c['Version id'] === src['Version id'])
    );

    return validSources.map(src => {
        const comp = components.find(c => c['Version id'] === src['Version id'])!;
        const counts = calculateVulnerabilityCounts(comp);

        // Extract project information from path
        const projectInfo = basePath
            ? extractProjectInfo(src['Path'], src['Origin name'], basePath, pathMappings)
            : extractProjectInfo(src['Path'], src['Origin name']);

        return {
            'Component name': src['Component name'],
            'Component version name': src['Component version name'],
            'Version id': src['Version id'],
            'Component Version Origin Id': src['Origin name id'],
            'Match type': normalizeMatchType(src['Match type']),
            'Path': src['Path'],
            'ProjectPath': projectInfo.projectPath,
            'VerifiedPath': projectInfo.verifiedPath,
            'VerifiedPathMethod': projectInfo.verifiedPathMethod,
            'Origin name': src['Origin name'],
            'License names': comp['License names'],
            'License families': comp['License families'],
            'License Risk': comp['License Risk'],
            'Critical Vulnerability Count': countCell(counts.critical),
            'High Vulnerability Count': countCell(counts.high),
            'Medium Vulnerability Count': countCell(counts.medium),
            'Low Vulnerability Count': countCell(counts.low),
            'Total Vulnerability Count': `${counts.total}`,
            'Critical and High Vulnerability Count': `${counts.criticalAndHigh}`,
            'Operational Risk': comp['Operational Risk'],
            'Release Date': formatDateField(comp['Release Date']),
            'Newer Versions': comp['Newer Versions'],
            'OpenHubURL': comp['Open Hub URL'],
            'Repository': '',
            'Group': ''
        };
    });
}

/**
 * Transforms security records into vulnerability details records
 * @param securityRecords Raw security records from Black Duck
 * @returns Transformed vulnerability detail records
 */
function transformVulnerabilityDetails(
    securityRecords: SecurityRecord[]
): Record<string, string>[] {
    return securityRecords.map(record => {
        const result: Record<string, string> = {};

        for (const key of VULNERABILITY_DETAILS_HEADERS) {
            if (key === 'Published on' || key === 'Updated on') {
                result[key] = formatDateField(record[key] || '');
            } else if (key === 'Component Version Origin Id') {
                result[key] = normalizeValue(record['Component origin id']);
            } else {
                result[key] = normalizeValue(record[key]);
            }
        }

        return result;
    });
}

/**
 * Transforms upgrade guidance CSV content
 * @param upgradeRaw Raw upgrade guidance CSV content
 * @returns Transformed upgrade guidance CSV content
 */
export function transformUpgradeGuidance(upgradeRaw: string): string {
    const rows = parse(upgradeRaw, { skip_empty_lines: true }) as string[][];
    if (rows.length === 0) {
        return '';
    }

    const [headers, ...dataRows] = rows;

    // Replace 'Component Origin External Id' with 'Component Version Origin Id'
    const modifiedHeaders = headers.map(h =>
        h.trim() === 'Component Origin External Id' ? 'Component Version Origin Id' : h
    );

    const keepIndexes = modifiedHeaders
        .map((h, i) => UPGRADE_GUIDANCE_COLUMNS_TO_REMOVE.has(h.trim()) ? -1 : i)
        .filter(i => i >= 0);

    const transformedRows = dataRows.map(row =>
        keepIndexes.map(i => row[i] ?? '')
    );

    return stringify([
        keepIndexes.map(i => modifiedHeaders[i]),
        ...transformedRows
    ], { header: false });
}

/**
 * Formats records according to a specific column order
 * @param records Records to format
 * @param columnOrder Column order to use
 * @returns Formatted records
 */
function formatRecordsWithColumnOrder<T extends readonly string[]>(
    records: Record<string, string>[],
    columnOrder: T
): Record<string, string>[] {
    return records.map(row => {
        const formattedRow: Record<string, string> = {};
        columnOrder.forEach(col => {
            formattedRow[col] = row[col] || '';
        });
        return formattedRow;
    });
}

/**
 * Validates that all required Black Duck report files are present
 * @param entries Directory entries
 * @returns Object with file names or throws error if files are missing
 */
function validateRequiredFiles(entries: string[]): {
    componentFile: string;
    sourceFile: string;
    securityFile: string;
    upgradeFile: string;
} {
    const componentFile = entries.find(f => f.startsWith('components_'));
    const sourceFile = entries.find(f => f.startsWith('source_'));
    const securityFile = entries.find(f => f.startsWith('security_'));
    const upgradeFile = entries.find(f => f.startsWith('project_version_upgrade_guidance_'));

    const missingFiles = [];
    if (!componentFile) missingFiles.push('components_*.csv');
    if (!sourceFile) missingFiles.push('source_*.csv');
    if (!securityFile) missingFiles.push('security_*.csv');
    if (!upgradeFile) missingFiles.push('project_version_upgrade_guidance_*.csv');

    if (missingFiles.length > 0) {
        throw new Error(`Missing required Black Duck CSV files: ${missingFiles.join(', ')}`);
    }

    return {
        componentFile: componentFile!,
        sourceFile: sourceFile!,
        securityFile: securityFile!,
        upgradeFile: upgradeFile!
    };
}

/**
 * Transforms raw Black Duck CSV exports into four cleaned and shareable CSV reports
 * @param reportDir Directory containing Black Duck report files
 * @param options Command options including optional basePath and pathMappings
 */
export async function transformBlackDuckReports(reportDir: string, options?: { basePath?: string, pathMappings?: string, repoCategories?: string }): Promise<void> {
    try {
        // Find and validate required input files
        const entries = await fs.readdir(reportDir);
        const { componentFile, sourceFile, securityFile, upgradeFile } = validateRequiredFiles(entries);

        let pathMappings: PathMappings | undefined = loadPathMappings(options);

        // Read input files 
        const componentsRawData = await fs.readFile(path.join(reportDir, componentFile), 'utf-8');
        const sourcesRawData = await fs.readFile(path.join(reportDir, sourceFile), 'utf-8');
        const securityRawData = await fs.readFile(path.join(reportDir, securityFile), 'utf-8');
        const upgradeRawData = await fs.readFile(path.join(reportDir, upgradeFile), 'utf-8');

        // Parse input data
        const components: ComponentRecord[] = parse(componentsRawData, CSV_PARSE_OPTIONS);
        const sources: SourceRecord[] = parse(sourcesRawData, CSV_PARSE_OPTIONS);
        const securityRecords: SecurityRecord[] = parse(securityRawData, CSV_PARSE_OPTIONS);

        // Transform and write _dependencies_sources.csv
        const dependenciesSourcesRecords = transformDependenciesSources(sources, components, options?.basePath, pathMappings);

        const emptyVerifiedPaths = dependenciesSourcesRecords.filter(record => record['VerifiedPath'] === '');
        if (emptyVerifiedPaths.length > 0) {
            console.warn(`Found ${emptyVerifiedPaths.length} out of ${dependenciesSourcesRecords.length} dependencies with empty verified paths.`);
        }

        const formattedDependenciesSources = formatRecordsWithColumnOrder(
            dependenciesSourcesRecords,
            DEPENDENCIES_SOURCES_COLUMN_ORDER
        );
        const dependenciesSourcesCSV = stringify(formattedDependenciesSources, { header: true });
        await fs.writeFile(path.join(reportDir, '_dependencies_sources.csv'), dependenciesSourcesCSV);

        // Transform and write _dependencies.csv
        const dependencyRecords = transformDependencies(components);
        const formattedDependencies = formatRecordsWithColumnOrder(
            dependencyRecords,
            DEPENDENCIES_COLUMN_ORDER
        );
        const dependenciesCSV = stringify(formattedDependencies, { header: true });
        await fs.writeFile(path.join(reportDir, '_dependencies.csv'), dependenciesCSV);

        // Transform and write _vulnerability_details.csv
        const vulnerabilityRecords = transformVulnerabilityDetails(securityRecords);
        const vulnerabilityCSV = stringify(vulnerabilityRecords, { header: true });
        await fs.writeFile(path.join(reportDir, '_vulnerability_details.csv'), vulnerabilityCSV);

        // Transform and write _upgrade_guidance.csv
        const upgradeGuidanceCSV = transformUpgradeGuidance(upgradeRawData);
        await fs.writeFile(path.join(reportDir, '_upgrade_guidance.csv'), upgradeGuidanceCSV);

        if (options?.repoCategories) {
            await addCategoriesToBlackDuckReports(reportDir, options.repoCategories);
        }
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to transform Black Duck reports: ${error.message}`);
        }
        throw error;
    }
}

export const transformBlackDuckReportsCommand = new Command()
    .command('transformBlackDuckReports')
    .description('Transforms Black Duck CSV reports to shareable format')
    .argument('<reportPath>', 'Path to the directory with Black Duck CSVs')
    .option('-b, --basePath <path>', 'Base path for verifying project paths')
    .option('-m, --pathMappings <path>', 'Path to JSON file containing path mappings')
    .option('--repoCategories <path>', 'Path to repo-to-category.csv')
    .action(transformBlackDuckReports);

function loadPathMappings(options: { basePath?: string; pathMappings?: string; repoCategories?: string; } | undefined) {
    let pathMappings: PathMappings | undefined = undefined;
    if (options?.pathMappings) {
        try {
            console.log(`Loading path mappings from ${options.pathMappings}`);

            if (!fsSync.existsSync(options.pathMappings)) {
                console.warn(`Path mapping file not found: ${options.pathMappings}`);
            } else {
                const fileContent = fsSync.readFileSync(options.pathMappings, 'utf8');
                const mappingData = JSON.parse(fileContent);

                if (!mappingData.pathMappings || !Array.isArray(mappingData.pathMappings)) {
                    console.warn(`Invalid path mapping file format: ${options.pathMappings}`);
                } else {
                    pathMappings = createPathMappings(mappingData.pathMappings);
                    console.log(`Loaded ${pathMappings.size} path mappings from ${options.pathMappings}`);
                }
            }
        } catch (error) {
            console.error(`Error loading path mappings: ${error}`);
        }
    }
    return pathMappings;
}
