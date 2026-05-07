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
        '^csv-parse/sync$': '<rootDir>/node_modules/csv-parse/dist/cjs/sync.cjs',
        '^csv-stringify/sync$': '<rootDir>/node_modules/csv-stringify/dist/cjs/sync.cjs',
    },
}
