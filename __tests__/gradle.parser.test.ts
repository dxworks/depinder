import {getIndentationLevel, parseGradleDependencyTree} from '../src/plugins/java/parsers/gradle'
import fs from 'fs'
import path from 'path'

describe('test parse deptree.txt', () => {
    it('Simple deptree should be parsed', async () => {

        const depTreeContent = fs.readFileSync(path.resolve(__dirname, 'assets', 'gradle-deptree.txt')).toString()
        const dependencies = parseGradleDependencyTree(depTreeContent, 'root@')

        console.log(dependencies)
    })
})

describe('test parsing correct indentation level', () => {
    it('should parse correctly for indentation 0', async () => {
        const line = '+--- com.fasterxml.jackson.core:jackson-databind:2.12.5'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(0)
    })
    it('should parse correctly for indentation 0 with \\', async () => {
        const line = '\\--- com.fasterxml.jackson.core:jackson-databind:2.12.5'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(0)
    })
    it('should parse correctly for indentation 1 with | and +', async () => {
        const line = '|    +--- com.google.guava:failureaccess:1.0.1'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(1)
    })
    it('should parse correctly for indentation 1 with | and \\', async () => {
        const line = '|    \\--- com.google.j2objc:j2objc-annotations:1.3'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(1)
    })
    it('should parse correctly for indentation 1 with spaces and +', async () => {
        const line = '     +--- net.bytebuddy:byte-buddy:1.11.3 -> 1.12.13'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(1)
    })
    it('should parse correctly for indentation 1 with spaces and \\', async () => {
        const line = '     \\--- org.objenesis:objenesis:3.2'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(1)
    })
    it('should parse correctly for indentation 2 with | and +', async () => {
        const line = '|    |    +--- com.fasterxml.jackson:jackson-bom:2.12.5'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(2)
    })
    it('should parse correctly for indentation 2 with | and \\', async () => {
        const line = '|    |    \\--- com.fasterxml.jackson:jackson-bom:2.12.5'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(2)
    })
    it('should parse correctly for indentation 2 with spaces and \\', async () => {
        const line = '          \\--- org.hamcrest:hamcrest:2.2'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(2)
    })
    it('should parse correctly for indentation 2 with spaces and +', async () => {
        const line = '          +--- org.hamcrest:hamcrest:2.2'
        const indentation = getIndentationLevel(line)
        expect(indentation).toBe(2)
    })

})
