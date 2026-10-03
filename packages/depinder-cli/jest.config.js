const path = require('path')
const csvParseSyncPath = path.join(path.dirname(require.resolve('csv-parse')), 'sync.cjs')
const csvStringifySyncPath = path.join(path.dirname(require.resolve('csv-stringify')), 'sync.cjs')

// eslint-disable-next-line no-undef
module.exports = {
    'roots': [
        '<rootDir>',
    ],
    'testMatch': [
        '**/__tests__/**/*.+(ts|tsx|js)',
        '**/?(*.)+(spec|test).+(ts|tsx|js)',
    ],
    'transform': {
        '^.+\\.(ts|tsx)$': 'ts-jest',
    },
    'testEnvironment': 'node',
    'moduleNameMapper': {
        '^csv-parse/sync$': csvParseSyncPath,
        '^csv-stringify/sync$': csvStringifySyncPath,
    },
}
