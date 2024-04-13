import { execSync } from 'child_process'

export function runMavenCommandSync(directory: string): void {
    try {
        const command = 'mvn dependency:tree -DoutputFile="deptree.txt"'
        execSync(command, { cwd: directory, encoding: 'utf-8' })
    } catch (error) {
        console.error('Error:', error)
        if (error instanceof Error && error.message) {
            console.error('Stdout:', error.message)
        }
        if (error instanceof Error && error.message) {
            console.error('Stderr:', error.message)
        }
    }
}
