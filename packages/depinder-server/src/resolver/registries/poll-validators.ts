import {toDate} from '@depinder/core'
import type {PollResult, PollTarget} from './types.js'

/** What a conditional GET vouches for: the rules the two poll-mode registries (maven, cargo) share. */

/**
 * How much older than the fetch a first check's `Last-Modified` has to be before it vouches for
 * the fetch. The fetch may have been answered by a CDN copy from shortly before a publish, and our
 * clock is not the registry's; ten minutes of doubt costs a redundant refetch at worst.
 */
export const FIRST_CHECK_MARGIN_MS = 10 * 60 * 1_000

/**
 * A 304: the registry says nothing has changed since the validators we sent. That vouches for the
 * package only when it has been fully fetched — validators are never kept newer than the data they
 * stand for (see {@link modified}) — so a row never fully fetched gains nothing from it.
 */
export function notModified(target: PollTarget): PollResult {
    return {changed: false, confirmed: target.fetchedAt !== null}
}

/**
 * A 200 to a conditional GET: what it means depends on what was stored.
 *
 *  - No full fetch yet (a row never fully fetched, such as an `error` row): it is queued for one already, and validators taken now
 *    would stand for data we do not have. Nothing is stored.
 *  - Validators were sent, so the registry says the package changed: re-fetch it, and clear the
 *    validators rather than storing the new ones. If that re-fetch fails, the next sweep is a first
 *    check against the old `fetched_at` and finds the change again, instead of a 304 against
 *    validators that already knew about it.
 *  - Nothing was sent (a first check): the file's `Last-Modified` decides. Newer than the fetch,
 *    less the margin, means it changed after we looked, so re-fetch. Older means the fetch saw
 *    this state: store the validators and vouch for the package. No header means we cannot tell;
 *    the validators are stored and nothing is vouched for.
 */
export function modified(target: PollTarget, headers: Headers): PollResult {
    if (!target.fetchedAt) return {changed: false, confirmed: false, etag: null, lastModified: null}

    if (target.etag || target.lastModified) {
        return {changed: true, confirmed: false, etag: null, lastModified: null}
    }

    const etag = headers.get('etag')
    const lastModified = headers.get('last-modified')
    const modifiedAt = toDate(lastModified)
    if (!modifiedAt) return {changed: false, confirmed: false, etag, lastModified}
    if (modifiedAt.getTime() > target.fetchedAt.getTime() - FIRST_CHECK_MARGIN_MS) {
        return {changed: true, confirmed: false}
    }
    return {changed: false, confirmed: true, etag, lastModified}
}
