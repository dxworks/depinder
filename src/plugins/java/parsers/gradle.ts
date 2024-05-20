import {DependencyFileContext, DepinderDependency, DepinderProject} from '../../../extension-points/extract'
import path from 'path'
import fs from 'fs'
import {getPackageSemver} from '../../../utils/utils'

export function parseGradleContext(context: DependencyFileContext): DepinderProject {

    const depTreeContent = fs.readFileSync(path.resolve(context.root, context.lockFile)).toString()

    const name = getGradleProjectName(context)
    const projectPath = path.resolve(context.root, context.manifestFile ?? 'build.gradle')
    const dependencies = parseGradleDependencyTree(depTreeContent, `${name}@`)

    return {
        name,
        version: '',
        dependencies,
        path: projectPath,
    } as DepinderProject
}

function getGradleProjectName(context: DependencyFileContext): string {
    const settingsFile = path.resolve(context.root, 'settings.gradle')
    if (fs.existsSync(settingsFile)) {
        const settingsContent = fs.readFileSync(settingsFile).toString()
        const match = settingsContent.match(/rootProject.name\s*=\s*['"](.*)['"]/)
        if (match) {
            return match[1]
        }
    }
    return path.basename(context.root)
}

export function parseGradleDependencyTree(gradleOutput: string, projectId: string): { [dependencyId: string]: DepinderDependency } {
    const lines = gradleOutput.split('\n')
    const configurations: { [config: string]: string[] } = {}
    let currentConfig = ''

    const dependencies: { [dependencyId: string]: DepinderDependency } = {}

    for (const line of lines) {
        if (line.includes(' - ') && !line.startsWith('(') && !line.trim().endsWith('(n)')) {
            currentConfig = line.split(' ')[0] ?? ''
            configurations[currentConfig] = []
        } else if (currentConfig && line.trim().startsWith('+---') || line.trim().startsWith('|') || line.trim().startsWith('\\---')) {
            configurations[currentConfig].push(line)
        }
    }

    Object.keys(configurations).flatMap((key) => {
        console.log(`config ${key} has ${configurations[key].length} dependencies`)
        return processDependencies(configurations[key], key, dependencies, projectId)
    })

    return dependencies
}

function processDependencies(dependencyLines: string[], type: string, dependencies: {
    [dependencyId: string]: DepinderDependency
}, projectId: string) {
    const parentStack: { id: string, indentation: number }[] = []

    dependencyLines.forEach(line => {
        const parsed = parseDependencyLine(line)
        if (parsed && !parsed.annotations.includes('(n)')) {
            const { name, version, indentation } = parsed
            const id = `${name}@${version}`

            dependencies[id] = dependencies[id] || {
                id,
                name,
                version,
                semver: getPackageSemver(version),
                type,
                requestedBy: [],
            }

            // Update the parent stack based on the current indentation level
            while (parentStack.length > 0 && parentStack[parentStack.length - 1].indentation >= indentation) {
                parentStack.pop()
            }

            // Set the parent for the current dependency
            const parent = parentStack[parentStack.length - 1]
            if (parent && !dependencies[id].requestedBy.includes(parent.id)) {
                dependencies[id].requestedBy.push(parent.id)
            }

            // If there is no parent, it's a direct dependency, add the projectId
            if (!parent && !dependencies[id].requestedBy.includes(projectId)) {
                dependencies[id].requestedBy.push(projectId)
            }

            // Add the current dependency to the parent stack
            parentStack.push({ id, indentation })
        }
    })
}

function parseDependencyLine(line: string): GradleDependencyInfo | null {
    const regex = /([\w.-]+:[\w.-]+):([\w.-]+)(?: -> ([\w.-]+))?(\s+\(([c*n])\))?/
    const match = line.match(regex)

    if (match) {
        const name = match[1]
        let version = match[2]
        const annotations = []
        const indentation = getIndentationLevel(line)

        if (match[3]) {
            version = match[3]
        }

        if (match[4]) {
            annotations.push(match[4].trim())
        }

        return { name, version, annotations, indentation, parent: null }
    }

    return null
}


interface GradleDependencyInfo {
    name: string;
    version: string;
    annotations: string[];
    indentation: number;
    parent: string | null;
}

export function getIndentationLevel(line: string): number {
    const firstPlus = line.indexOf('+')
    const firstBackslash = line.indexOf('\\')

    return Math.max(firstPlus, firstBackslash) / 5
}
