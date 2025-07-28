import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { extractProjectInfo, ProjectPathInfo } from '../utils/projectMapping';

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

/**
 * Column order for dependencies.csv output
 */
const DEPENDENCIES_COLUMN_ORDER = [
  'Component name',
  'Component version name',
  'License names',
  'License families',
  'Match type',
  'Usage',
  'Operational Risk',
  'Origin name',
  'Origin id',
  'License Risk',
  'Total Vulnerability Count',
  'Critical and High Vulnerability Count',
  'Critical Vulnerability Count',
  'High Vulnerability Count',
  'Medium Vulnerability Count',
  'Low Vulnerability Count',
  'Release Date',
  'Newer Versions',
  'Commit Activity',
  'Commits in Past 12 Months',
  'Contributors in Past 12 Months',
  'Has License Conflicts',
  'Component Link',
  'Open Hub URL'
] as const;

/**
 * Column order for dependencies_sources.csv output
 */
const DEPENDENCIES_SOURCES_COLUMN_ORDER = [
  'Component name',
  'Component version name',
  'ComponentWithVersion',
  'Match type',
  'Path',
  'ProjectPath',
  'ProjectPathExists',
  'VerifiedPath',
  'Origin name',
  'License names',
  'License families',
  'License Risk',
  'Critical Vulnerability Count',
  'High Vulnerability Count',
  'Medium Vulnerability Count',
  'Low Vulnerability Count',
  'Total Vulnerability Count',
  'Critical and High Vulnerability Count',
  'Operational Risk',
  'Release Date',
  'Newer Versions',
  'OpenHubURL'
] as const;

/**
 * Headers to keep for vulnerability_details.csv output
 */
const VULNERABILITY_DETAILS_HEADERS = [
  'Component name', 
  'Component version name', 
  'Vulnerability id', 
  'Description', 
  'Published on', 
  'Updated on',
  'Base score', 
  'Exploitability', 
  'Impact', 
  'Vulnerability source', 
  'Remediation status', 
  'URL',
  'Security Risk', 
  'Project path', 
  'Overall score', 
  'CWE Ids', 
  'Solution available', 
  'Workaround available',
  'Exploit available', 
  'CVSS Version', 
  'Match type', 
  'Vulnerability tags'
];

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

/**
 * Formats a date string from MM/DD/YY to \tYYYY-MM-DD format for Excel compatibility
 * @param raw Raw date string in MM/DD/YY format
 * @returns Formatted date string or empty string if invalid
 */
function formatDateField(raw: string): string {
  if (!raw) return '';
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return '';
  const [month, day, year] = parts.map(s => parseInt(s, 10));
  if (isNaN(month) || isNaN(day) || isNaN(year)) return '';
  const fullYear = year < 50 ? 2000 + year : 1900 + year;
  return `\t${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

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
 * Normalizes match type by removing " Dependency" suffix
 * @param matchType Match type string
 * @returns Normalized match type
 */
function normalizeMatchType(matchType: string): string {
  return (matchType || '').replace(/ Dependency/g, '');
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
      'License names': component['License names'],
      'License families': component['License families'],
      'Match type': normalizeMatchType(component['Match type']),
      'Usage': component['Usage'],
      'Operational Risk': component['Operational Risk'],
      'License Risk': component['License Risk'],
      'Total Vulnerability Count': `${counts.total}`,
      'Critical and High Vulnerability Count': `${counts.criticalAndHigh}`,
      'Critical Vulnerability Count': counts.critical > 0 ? `${counts.critical}` : '',
      'High Vulnerability Count': counts.high > 0 ? `${counts.high}` : '',
      'Medium Vulnerability Count': counts.medium > 0 ? `${counts.medium}` : '',
      'Low Vulnerability Count': counts.low > 0 ? `${counts.low}` : '',
      'Release Date': formatDateField(component['Release Date']),
      'Newer Versions': component['Newer Versions'],
      'Open Hub URL': component['Open Hub URL']
    };
    
    // Handle optional fields
    result['Origin name'] = component['Origin name'] || '';
    result['Origin id'] = component['Origin id'] || '';
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
  basePath?: string
): Record<string, string>[] {
  return sources.map(src => {
    const comp = components.find(c => c['Version id'] === src['Version id']);
    if (!comp) return null;

    const counts = calculateVulnerabilityCounts(comp);
    
    // Extract project information from the path and origin name
    const projectInfo = extractProjectInfo(src['Path'], src['Origin name'], basePath);
    
    return {
      'Component name': src['Component name'],
      'Component version name': src['Component version name'],
      'ComponentWithVersion': `${src['Component name']}/${src['Component version name']}`,
      'Match type': normalizeMatchType(src['Match type']),
      'Path': src['Path'],
      'ProjectPath': projectInfo.projectPath,
      'VerifiedPath': projectInfo.verifiedPath,
      'ProjectPathExists': projectInfo.projectPathExists !== undefined ? String(projectInfo.projectPathExists) : '',
      'Origin name': src['Origin name'],
      'License names': comp['License names'],
      'License families': comp['License families'],
      'License Risk': comp['License Risk'],
      'Critical Vulnerability Count': counts.critical > 0 ? `${counts.critical}` : '',
      'High Vulnerability Count': counts.high > 0 ? `${counts.high}` : '',
      'Medium Vulnerability Count': counts.medium > 0 ? `${counts.medium}` : '',
      'Low Vulnerability Count': counts.low > 0 ? `${counts.low}` : '',
      'Total Vulnerability Count': `${counts.total}`,
      'Critical and High Vulnerability Count': `${counts.criticalAndHigh}`,
      'Operational Risk': comp['Operational Risk'],
      'Release Date': formatDateField(comp['Release Date']),
      'Newer Versions': comp['Newer Versions'],
      'OpenHubURL': comp['Open Hub URL'],
      'Repository': '',
      'Group': ''
    };
  }).filter(Boolean) as Record<string, string>[];
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
function transformUpgradeGuidance(upgradeRaw: string): string {
  const [headerLine, ...lines] = upgradeRaw.trim().split('\n');
  const headers = headerLine.split(',');

  const keepIndexes = headers
    .map((h, i) => UPGRADE_GUIDANCE_COLUMNS_TO_REMOVE.has(h.trim()) ? -1 : i)
    .filter(i => i >= 0);
    
  return [
    keepIndexes.map(i => headers[i]).join(','),
    ...lines.map(line => {
      const parts = line.split(',');
      return keepIndexes.map(i => parts[i] ?? '').join(',');
    })
  ].join('\n');
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
 * @param options Command options including optional basePath
 */
export async function transformBlackDuckReports(reportDir: string, options?: { basePath?: string }): Promise<void> {
  try {
    // Find and validate required input files
    const entries = await fs.readdir(reportDir);
    const { componentFile, sourceFile, securityFile, upgradeFile } = validateRequiredFiles(entries);

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
    const dependenciesSourcesRecords = transformDependenciesSources(sources, components, options?.basePath);
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
  .action(transformBlackDuckReports);