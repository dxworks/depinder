import {LibraryInfo} from '../extension-points/registrar'

export interface Cache {
    get: (key: string) => LibraryInfo | Promise<LibraryInfo> | undefined | any
    set: (key: string, value: LibraryInfo) => void | Promise<void>
    has: (key: string) => boolean | Promise<boolean>
    load: () => void | Promise<void>,
    /**
     * Makes everything written so far durable and LEAVES THE CACHE USABLE.
     *
     * Separate from `write` because `write` is also the teardown step: the Mongo cache closes its
     * connection there, so calling it from the mid-run checkpoint dropped the connection under a
     * run that then failed every remaining lookup. A cache whose `set` is already durable (Mongo)
     * implements this as a no-op; one that batches in memory (the JSON file) serialises here.
     * Optional: a cache that does not implement it simply keeps the pre-checkpoint behaviour of
     * only becoming durable at the end of the run.
     */
    flush?: () => void | Promise<void>,
    write: () => void | Promise<void>,
}

export const noCache: Cache = {
    get(key: string): LibraryInfo | undefined {
        return undefined
    },
    set(key: string, value: LibraryInfo): void {

    },
    has(key: string): boolean {
        return false
    },
    load() {
    },
    flush() {
    },
    write() {
    },
}