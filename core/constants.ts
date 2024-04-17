export const OUTDATED_MONTHS = 12
export const OUT_OF_SUPPORT_MONTHS = 24

export const extractorFiles: Map<string, string[]> = new Map<string, string[]>(
    [
        ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts', 'deptree.txt']],
        ['dotnet', ['*.csproj', '*.fsproj', '*.vbproj']],
        ['javascript', ['package.json', 'package-lock.json', 'yarn.lock']],
        ['php', ['composer.json', 'composer.lock']],
        ['python', ['requirements.txt', 'setup.py', 'Pipfile', 'Pipfile.lock', 'pyproject.toml', 'poetry.lock']],
        ['ruby', ['Gemfile', '*.gemspec', 'Gemfile.lock']],
    ]
)

export const fileToPackageManager: Map<string, string> = new Map<string, string>([
        ['pom.xml', 'Maven'],
        ['deptree.txt', 'Maven'],
        ['build.gradle', 'Gradle'],
        ['build.gradle.kts', 'Gradle'],
        ['*.csproj', 'NuGet'],
        ['*.fsproj', 'NuGet'],
        ['*.vbproj', 'NuGet'],
        ['package.json', 'npm'],
        ['package-lock.json', 'npm'],
        ['yarn.lock', 'Yarn'],
        ['composer.json', 'Composer'],
        ['composer.lock', 'Composer'],
        ['requirements.txt', 'pip'],
        ['setup.py', 'setuptools'],
        ['Pipfile', 'pipenv'],
        ['Pipfile.lock', 'pipenv'],
        ['pyproject.toml', 'Poetry'],
        ['poetry.lock', 'Poetry'],
        ['Gemfile', 'Bundler'],
        ['*.gemspec', 'RubyGems'],
        ['Gemfile.lock', 'Bundler'],
])

export enum Severity {
    CRITICAL = 'CRITICAL',
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    LOW = 'LOW',
    NONE = 'NONE'
}