import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { parse } from 'csv-parse/sync';
import { csvDocument, NamedRow } from '../utils/csv';
import { createCategoryReports } from '../utils/blackDuckReportCategories';
import { addReportVerificationOptions } from './reportVerificationOptions';
import {
    loadVerificationOptions, printVerificationSummary, ReportVerificationOptions, VerificationConfig, verifySourcePaths
} from '../utils/reportVerification';

const SOURCES_FILE = '_dependencies_sources.csv';

async function findReportDirectories(reportPath: string): Promise<string[]> {
    const entries = await fs.readdir(reportPath, { withFileTypes: true });
    const candidates = [reportPath, ...entries
        .filter(entry => entry.isDirectory() && ['trivy', 'syft'].includes(entry.name))
        .map(entry => path.join(reportPath, entry.name))];
    const directories: string[] = [];
    for (const candidate of candidates) {
        if ((await fs.readdir(candidate)).includes(SOURCES_FILE)) directories.push(candidate);
    }
    if (!directories.length) {
        throw new Error(`No ${SOURCES_FILE} found in ${reportPath} or its trivy/syft subfolders`);
    }
    return directories;
}

function parseSourceReport(raw: string): { headers: string[]; rows: NamedRow[] } {
    const [headers = [], ...data] = parse(raw, { bom: true, skip_empty_lines: true }) as string[][];
    if (!headers.length) return { headers, rows: [] };
    if (!headers.includes('ProjectPath')) throw new Error(`${SOURCES_FILE} is missing ProjectPath column`);
    if (new Set(headers).size !== headers.length) throw new Error(`${SOURCES_FILE} contains duplicate columns`);
    return {
        headers,
        rows: data.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index]])))
    };
}

async function prepareVerification(reportDir: string, config: VerificationConfig) {
    try {
        const { headers, rows } = parseSourceReport(await fs.readFile(path.join(reportDir, SOURCES_FILE), 'utf8'));
        const verifiedRows = verifySourcePaths(rows, config.basePath, config.pathMappings);
        const reports: Record<string, string> = {};
        if (rows.length) {
            const outputHeaders = [...headers];
            for (const column of ['VerifiedPath', 'VerifiedPathMethod']) {
                if (!outputHeaders.includes(column)) outputHeaders.push(column);
            }
            reports[SOURCES_FILE] = csvDocument(outputHeaders, verifiedRows);
            if (config.repoCategories) {
                const dependenciesRaw = await fs.readFile(path.join(reportDir, '_dependencies.csv'), 'utf8');
                Object.assign(reports, createCategoryReports(dependenciesRaw, reports[SOURCES_FILE], config.repoCategories));
            }
        }
        return { reportDir, reports, rows: verifiedRows };
    } catch (error) {
        throw new Error(`Failed to verify paths in ${reportDir}: ${error}`);
    }
}

async function verifyPaths(reportPath: string, options: ReportVerificationOptions): Promise<void> {
    const config = loadVerificationOptions(options);
    const directories = await findReportDirectories(reportPath);
    const plans = await Promise.all(directories.map(directory => prepareVerification(directory, config)));
    for (const plan of plans) {
        for (const [fileName, content] of Object.entries(plan.reports)) {
            await fs.writeFile(path.join(plan.reportDir, fileName), content);
        }
        printVerificationSummary(plan.reportDir, plan.rows);
    }
}

export function createVerifyPathsCommand(): Command {
    const command = new Command()
        .command('verifyPaths')
        .description('Verifies project paths in analyse or transformed Black Duck reports in place')
        .argument('<reportPath>', 'Path to a report directory or analyse output directory');
    return addReportVerificationOptions(command, true).action(verifyPaths);
}

export const verifyPathsCommand = createVerifyPathsCommand();
