import {inheritFromParents, mavenProjectUrlInherited} from '../src/plugins/java'

const child = `<project>
  <parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>3</version></parent>
  <artifactId>child</artifactId>
</project>`
const parent = `<project>
  <parent><groupId>org.example</groupId><artifactId>root</artifactId><version>1</version></parent>
  <artifactId>parent</artifactId>
  <url>https://example.org/parent</url>
</project>`
const root = `<project>
  <artifactId>root</artifactId>
  <licenses><license><name>Apache-2.0</name></license><license><name>MIT</name></license></licenses>
  <url>https://example.org/root</url>
</project>`

describe('pom inheritance', () => {
    const fetched: string[] = []
    beforeEach(() => {
        fetched.length = 0
        ;(global as any).fetch = jest.fn(async (url: string) => {
            fetched.push(url)
            const body = url.includes('/parent/3/') ? parent : url.includes('/root/1/') ? root : ''
            return {status: body ? 200 : 404, text: async () => body}
        })
    })

    it('takes licences from the first ancestor that declares them, and url from the nearest', async () => {
        const pom = await inheritFromParents(new (require('fast-xml-parser').XMLParser)().parse(child))
        expect(pom.project.url).toBe('https://example.org/parent')
        expect(pom.project.licenses.license.map((it: any) => it.name)).toEqual(['Apache-2.0', 'MIT'])
        expect(fetched).toEqual([
            'https://repo1.maven.org/maven2/org/example/parent/3/parent-3.pom',
            'https://repo1.maven.org/maven2/org/example/root/1/root-1.pom',
        ])
    })

    it('does not fetch when the pom already declares both', async () => {
        const full = `<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version></parent>
            <licenses><license><name>MIT</name></license></licenses><url>https://x</url></project>`
        expect(await mavenProjectUrlInherited(full)).toBe('https://x')
        expect(fetched).toEqual([])
    })

    it('keeps the pom as is when the parent is not on the repository', async () => {
        const orphan = `<project><parent><groupId>g</groupId><artifactId>missing</artifactId><version>1</version></parent></project>`
        expect(await mavenProjectUrlInherited(orphan)).toBe('')
    })
})
