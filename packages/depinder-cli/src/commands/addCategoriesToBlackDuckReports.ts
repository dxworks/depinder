import { Command } from 'commander';
import { addCategoriesToBlackDuckReports } from '../utils/blackDuckReportCategories';

export const addCategoriesToBlackDuckReportsCommand = new Command()
    .command('addCategoriesToBlackDuckReports')
    .description('Adds repository categories to transformed Black Duck dependency reports')
    .argument('<reportPath>', 'Path to the directory containing _dependencies.csv and _dependencies_sources.csv')
    .argument('<repoCategoriesPath>', 'Path to repo-to-category.csv')
    .action(addCategoriesToBlackDuckReports);
