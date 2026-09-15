import {npmProjectUrl} from '../src/plugins/javascript'

describe('npm Component Link', () => {
    const packument = (versions: Record<string, any>, homepage?: string) => ({
        homepage,
        time: Object.fromEntries(Object.keys(versions).map((v, i) => [v, `2020-0${i + 1}-01T00:00:00Z`])),
        versions: Object.fromEntries(Object.entries(versions).map(([v, it]) => [v, {version: v, ...it}])),
    })

    it('takes the packument homepage first', () => {
        expect(npmProjectUrl(packument({'1.0.0': {repository: {url: 'git+https://github.com/a/b.git'}}}, 'https://a.dev')))
            .toBe('https://a.dev')
    })

    it('falls back to the newest version that declares a homepage', () => {
        const p = packument({
            '1.0.0': {homepage: 'https://old.example'},
            '2.0.0': {homepage: 'https://newer.example'},
            '3.0.0': {},
        })
        expect(npmProjectUrl(p)).toBe('https://newer.example')
    })

    it('falls back to the repository, string or object', () => {
        expect(npmProjectUrl(packument({'1.0.0': {repository: {url: 'git+https://github.com/a/b.git'}}})))
            .toBe('git+https://github.com/a/b.git')
        expect(npmProjectUrl(packument({'1.0.0': {repository: 'github:a/b'}}))).toBe('github:a/b')
    })

    it('writes nothing when no version declares anything', () => {
        expect(npmProjectUrl(packument({'1.0.0': {}, '1.0.1': {}}))).toBe('')
        expect(npmProjectUrl({})).toBe('')
    })
})
