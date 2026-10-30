import * as fs from 'fs';
import { NamedRow } from './csv';
import { createPathMappings, getMavenArtifactName, PathMappings, verifyProjectPath } from './projectMapping';
import { parseRepoCategories } from './blackDuckReportCategories';

export interface ReportVerificationOptions {
    basePath?: string;
    pathMappings?: string;
    repoCategories?: string;
}

export interface VerificationConfig {
    basePath?: string;
    pathMappings?: PathMappings;
    repoCategories?: Map<string, string>;
}

export function loadVerificationOptions(options: ReportVerificationOptions = {}): VerificationConfig {
    if (options.basePath !== undefined) {
        try {
            if (!fs.statSync(options.basePath).isDirectory()) {
                throw new Error('Expected a directory');
            }
        } catch (error) {
            throw new Error(`Invalid base path ${options.basePath}: ${error}`);
        }
    }
    const pathMappings = loadPathMappings(options.pathMappings);
    let repoCategories: Map<string, string> | undefined;
    if (options.repoCategories !== undefined) {
        try {
            repoCategories = parseRepoCategories(fs.readFileSync(options.repoCategories, 'utf8'));
        } catch (error) {
            throw new Error(`Invalid repository categories ${options.repoCategories}: ${error}`);
        }
    }
    return { basePath: options.basePath, pathMappings, repoCategories };
}

export function verifySourcePaths(rows: NamedRow[], basePath?: string, pathMappings?: PathMappings): NamedRow[] {
    return rows.map(row => {
        const result = verifyProjectPath(
            row['ProjectPath'] || '', basePath || '', pathMappings, getMavenArtifactName(row['Path'] || '')
        );
        return { ...row, VerifiedPath: result.verifiedPath, VerifiedPathMethod: result.verifiedPathMethod };
    });
}

function loadPathMappings(filePath?: string): PathMappings | undefined {
    if (filePath === undefined) return undefined;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data || !Array.isArray(data.pathMappings)) {
            throw new Error('Expected a pathMappings array');
        }
        for (const mapping of data.pathMappings) {
            if (!mapping || typeof mapping.extractedPath !== 'string' || !mapping.extractedPath.trim()
                || typeof mapping.actualPath !== 'string' || !mapping.actualPath.trim()) {
                throw new Error('Each mapping needs nonempty extractedPath and actualPath strings');
            }
        }
        return createPathMappings(data.pathMappings);
    } catch (error) {
        throw new Error(`Invalid path mappings ${filePath}: ${error}`);
    }
}

export function printVerificationSummary(reportDir: string, rows: NamedRow[]): void {
    const verified = rows.filter(row => row['VerifiedPath']).length;
    console.log(`Verified paths in ${reportDir}: ${verified} verified, ${rows.length - verified} unverified, ${rows.length} total.`);
}
