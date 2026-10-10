import type {PackageRecord} from '@depinder/core'
import {LibraryInfo} from '../extension-points/library-info'

/**
 * The resolver is asked about a purl at most once per process.
 *
 * One `analyse` can run two sources — the Trivy and the Syft SBOMs of the same repositories — and
 * each has a bulk phase of its own. A `refreshing` answer the first one wrote is stored already
 * expired (see `confirmedAtMs`), so without this the second would ask the server about the same
 * purl again: a retry by another name. Instead a purl in `askedThisProcess` is never sent again,
 * and every answer that was taken is kept here under its cache key, with the `updated_at` it was
 * written with, so a later source hands the very same object to its phase 3 — or, under a key the
 * earlier source did not write, the same answer written afresh (`answeredPurls`). A purl that was asked
 * and got no usable answer has nothing in here: its key is a cache hit if the registry fallback has
 * since filled it, and goes to the registry fallback otherwise.
 *
 * Reset per `analyseFiles`, next to `resetResolverClient`.
 */
export const askedThisProcess = new Set<string>()
export const answeredThisProcess = new Map<string, {lib: LibraryInfo, updatedAt: number}>()
/**
 * The same answers, per purl as sent: the package and its `updated_at`. Needed because one purl can
 * belong to different cache keys in different sources — Trivy lowercases a golang module path that
 * Syft keeps in its original case, so `go:github.com/kimmachinegun/automemlimit` and
 * `go:github.com/KimMachineGun/automemlimit` are one purl and two keys. A later source whose key
 * the earlier one never wrote gets the earlier answer written under it, rather than a registry call.
 */
export const answeredPurls = new Map<string, {pkg: PackageRecord, updatedAt: number}>()

/** For tests, and for a second `analyseFiles` in the same process. */
export function resetBulkResolve(): void {
    askedThisProcess.clear()
    answeredThisProcess.clear()
    answeredPurls.clear()
}
