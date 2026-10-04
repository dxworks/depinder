/**
 * What the api and the worker say to each other inside one process.
 *
 * Both halves already talk through the database — the queue row and the package row are the real
 * record, and everything here is only a way of not waiting for a timer to find out what has
 * already happened. Nothing depends on an event arriving: `ROLE=resolver-api` and `ROLE=resolver-worker` in separate
 * processes, or two instances behind a load balancer, never hear each other and fall back to the
 * database poll and the idle nap, just slower.
 *
 * Three signals:
 *
 *  - `settled` — the worker has committed a package's terminal status, so a request waiting on it
 *    can look now rather than on its next poll. Emitted **after** the commit, never inside the
 *    transaction, or the api reads a row it cannot see yet.
 *  - `queued` — a request has committed new work, so the fill pump can go back to the queue rather
 *    than finish its nap.
 *  - `wanted` — a request now waits for a package, until a deadline, so a fetch of it that is
 *    already running can rank as urgent in its registry limiter until then.
 *
 * It is deliberately not an `EventEmitter`: a listener per key on a 5 000-purl request would trip
 * Node's `maxListeners` warning, so `/resolve` subscribes one listener and consults its own pending
 * set. A listener that throws is swallowed — this is called from the middle of the write path, and
 * a bad subscriber must not fail a package that is already committed.
 */
export interface ResolverEvents {
    /** A package reached a terminal status and the transaction carrying it has committed. */
    settled(packageKey: string): void
    /** Subscribes to {@link settled}. The returned function removes the listener. */
    onSettled(listener: (packageKey: string) => void): () => void
    /** Work has been committed to `fetch_queue`. */
    queued(): void
    /** Subscribes to {@link queued}. The returned function removes the listener. */
    onQueued(listener: () => void): () => void
    /** A caller waits for a package until `until` (epoch ms). Committed to `fetch_queue` already. */
    wanted(packageKey: string, until: number): void
    /** Subscribes to {@link wanted}. The returned function removes the listener. */
    onWanted(listener: (packageKey: string, until: number) => void): () => void
    /** Listeners held, both kinds. A number that only grows is a leaked `finally`. */
    readonly listeners: number
}

export function createResolverEvents(): ResolverEvents {
    const settled = new Set<(packageKey: string) => void>()
    const queued = new Set<() => void>()
    const wanted = new Set<(packageKey: string, until: number) => void>()

    return {
        settled(packageKey) {
            for (const listener of settled) {
                try {
                    listener(packageKey)
                } catch {
                    // A subscriber's problem, not this package's.
                }
            }
        },

        onSettled(listener) {
            settled.add(listener)
            return () => settled.delete(listener)
        },

        queued() {
            for (const listener of queued) {
                try {
                    listener()
                } catch {
                    // As above.
                }
            }
        },

        onQueued(listener) {
            queued.add(listener)
            return () => queued.delete(listener)
        },

        wanted(packageKey, until) {
            for (const listener of wanted) {
                try {
                    listener(packageKey, until)
                } catch {
                    // As above.
                }
            }
        },

        onWanted(listener) {
            wanted.add(listener)
            return () => wanted.delete(listener)
        },

        get listeners(): number {
            return settled.size + queued.size + wanted.size
        },
    }
}
