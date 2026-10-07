import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import {afterAll} from 'vitest'

// Every test file runs against a throwaway home: the cache (`~/.dxw/depinder/cache`) and the log
// file land there, never in the developer's own `~/.dxw/depinder`.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-test-home-'))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
afterAll(() => fs.rmSync(tempHome, {recursive: true, force: true}))

// None of the developer's own settings or tokens reach a test: no DEPINDER_CACHE_DB pointing at a
// real cache, no resolver (on by default at libs.dxworks.org), no GitHub or Libraries.io key that
// would turn a lookup into a live call. Tests that need one set it themselves.
for (const name of Object.keys(process.env)) {
    if (name.startsWith('DEPINDER_') || name === 'GH_TOKEN' || name.startsWith('GH_TOKEN_')
        || name === 'LIBRARIES_IO_API_KEY') {
        delete process.env[name]
    }
}

// No live registries: a connection to anything but this machine fails the call that made it.
// Tests stub their HTTP or serve it on loopback.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** The host a `socket.connect(...)` call dials: from `(options)`, `([options, cb])` or `(port, host)`. */
function dialledHost(args: unknown[]): string {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    if (typeof first === 'object' && first !== null) {
        const options = first as {host?: string, path?: string}
        return options.path ? 'localhost' : options.host ?? 'localhost'
    }
    return typeof args[1] === 'string' ? args[1] : 'localhost'
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const host = dialledHost(args)
    if (!LOOPBACK_HOSTS.has(host)) throw new Error(`A test tried to reach ${host}: stub it or serve it on loopback`)
    return (connect as (...rest: unknown[]) => net.Socket).apply(this, args)
} as typeof net.Socket.prototype.connect
