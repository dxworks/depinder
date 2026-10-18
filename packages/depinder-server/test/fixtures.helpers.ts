import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'

/** The recorded upstream answers the tests read: this project's own, and core's. */

/** An answer recorded for this project (feeds, scanners), from `test/fixtures/`. */
export function serverFixture(name: string): string {
    return readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
}

/** A registry answer recorded with core's fetchers, from `@depinder/core/fixtures/`. */
export function coreFixture(name: string): string {
    return readFileSync(createRequire(import.meta.url).resolve(`@depinder/core/fixtures/${name}`), 'utf8')
}
