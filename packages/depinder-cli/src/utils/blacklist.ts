import path from 'path'
import fs from 'fs'

const blacklistFile = path.join(process.cwd(), '.blacklist')

export const blacklistedGlobs = fs.existsSync(blacklistFile) ?
    fs.readFileSync(blacklistFile).toString().split('\n').filter(it => it.trim() !== '' && !it.startsWith('#'))
    : []