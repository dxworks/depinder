import { Command, Option } from 'commander';

export function addReportVerificationOptions(command: Command, basePathRequired = false): Command {
    return command
        .addOption(new Option('-b, --basePath <path>', 'Base path for verifying project paths')
            .makeOptionMandatory(basePathRequired))
        .option('-m, --pathMappings <path>', 'Path to JSON file containing path mappings')
        .option('--repoCategories <path>', 'Path to repo-to-category.csv');
}
