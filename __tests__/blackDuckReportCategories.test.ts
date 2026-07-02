import {
    addCategoriesToReports,
    COULD_NOT_MAP_REPOSITORY_CATEGORY,
    parseRepoCategories
} from '../src/utils/blackDuckReportCategories';

describe('blackDuckReportCategories', () => {
    it('adds source repository and dependency category rows', () => {
        const repoCategories = parseRepoCategories(`repo,category
Core-Web,Active
legacy-api,Deprecated
`);
        const dependenciesSources = [
            sourceRow('origin-1', 'core-web/app', 'src-1'),
            sourceRow('origin-1', 'legacy-api/service', 'src-2'),
            sourceRow('origin-1', 'CORE-WEB/admin', 'src-3'),
            sourceRow('origin-2', '', 'src-4')
        ];
        const dependencies = [
            dependencyRow('origin-1', 'dep-1'),
            dependencyRow('origin-2', 'dep-2')
        ];

        const result = addCategoriesToReports(dependencies, dependenciesSources, repoCategories);

        expect(result.dependenciesSourcesByCategory).toEqual([
            { Repository: 'core-web', Category: 'Active', ...dependenciesSources[0] },
            { Repository: 'legacy-api', Category: 'Deprecated', ...dependenciesSources[1] },
            { Repository: 'CORE-WEB', Category: 'Active', ...dependenciesSources[2] },
            { Repository: '', Category: '', ...dependenciesSources[3] }
        ]);
        expect(result.dependenciesByCategory).toEqual([
            { Category: 'Active', ...dependencies[0] },
            { Category: 'Deprecated', ...dependencies[0] },
            { Category: '', ...dependencies[1] }
        ]);
    });

    it('uses sentinel category for unmapped repositories', () => {
        const result = addCategoriesToReports(
            [dependencyRow('origin-1', 'dep-1')],
            [sourceRow('origin-1', 'unknown-repo/app', 'src-1')],
            parseRepoCategories('repo,category\nknown-repo,Active\n')
        );

        expect(result.dependenciesSourcesByCategory[0].Category).toBe(COULD_NOT_MAP_REPOSITORY_CATEGORY);
        expect(result.dependenciesByCategory[0].Category).toBe(COULD_NOT_MAP_REPOSITORY_CATEGORY);
    });

    it('fails when the repo mapping has duplicate repo keys case-insensitively', () => {
        expect(() => parseRepoCategories(`repo,category
core-web,Active
CORE-WEB,Deprecated
`)).toThrow('repo-to-category.csv contains duplicate repo: CORE-WEB');
    });

    it('fails when repo mapping category is empty', () => {
        expect(() => parseRepoCategories('repo,category\ncore-web,\n'))
            .toThrow('repo-to-category.csv contains an empty category for repo: core-web');
    });

    it('fails when dependency join keys are empty', () => {
        expect(() => addCategoriesToReports(
            [dependencyRow('', 'dep-1')],
            [sourceRow('origin-1', 'core-web/app', 'src-1')],
            parseRepoCategories('repo,category\ncore-web,Active\n')
        )).toThrow('_dependencies.csv contains an empty Component Version Origin Id at data row 1');
    });

    it('fails when source join keys are empty', () => {
        expect(() => addCategoriesToReports(
            [dependencyRow('origin-1', 'dep-1')],
            [sourceRow('', 'core-web/app', 'src-1')],
            parseRepoCategories('repo,category\ncore-web,Active\n')
        )).toThrow('_dependencies_sources.csv contains an empty Component Version Origin Id at data row 1');
    });
});

function dependencyRow(originId: string, componentName: string): Record<string, string> {
    return {
        'Component Version Origin Id': originId,
        'Component name': componentName,
        'Component version name': '1.0.0'
    };
}

function sourceRow(originId: string, verifiedPath: string, componentName: string): Record<string, string> {
    return {
        'Component Version Origin Id': originId,
        VerifiedPath: verifiedPath,
        'Component name': componentName
    };
}
