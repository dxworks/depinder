/**
 * Per-ecosystem politeness: how many requests may be in flight at once and how far apart their
 * starts must be. The numbers always come from the caller (D18); this file has none of its own.
 */

export interface LimitSpec {
    /** Requests in flight at once for this ecosystem. */
    concurrency: number
    /** Minimum gap between two request *starts*. 0 = no pacing. */
    minIntervalMs: number
}

/** The limits for every purl type: its own row, or the fallback. */
export interface EcosystemLimits {
    byType: Readonly<Record<string, LimitSpec>>
    fallback: LimitSpec
}

export function limitFor(limits: EcosystemLimits, type: string): LimitSpec {
    return limits.byType[type] ?? limits.fallback
}

/**
 * Chooses which waiting request goes next, as an index into `waiting` (oldest first). Each waiter
 * is represented by the tag it was queued with. The default is 0: first come, first served.
 */
export type WaiterPicker<Tag> = (waiting: readonly Tag[]) => number

export interface RequestLimiter<Tag = undefined> {
    readonly spec: LimitSpec
    /** Runs `task` once a slot is free and the picker chooses it. */
    run<T>(task: () => Promise<T>, tag?: Tag): Promise<T>
}

interface Waiter<Tag> {
    tag: Tag | undefined
    grant: () => void
}

class QueueLimiter<Tag> implements RequestLimiter<Tag> {
    private active = 0
    /** In arrival order; which one goes next is the picker's choice. */
    private waiters: Waiter<Tag>[] = []
    /** Earliest wall-clock time the next request may start, reserved synchronously. */
    private nextSlot = 0

    constructor(
        readonly spec: LimitSpec,
        private readonly pick: WaiterPicker<Tag | undefined>,
    ) {}

    async run<T>(task: () => Promise<T>, tag?: Tag): Promise<T> {
        await this.acquire(tag)
        try {
            return await task()
        } finally {
            this.release()
        }
    }

    private async acquire(tag: Tag | undefined): Promise<void> {
        if (this.active < this.spec.concurrency) {
            this.active++
        } else {
            await new Promise<void>(grant => this.waiters.push({tag, grant}))
        }
        await this.pace()
    }

    private release(): void {
        if (this.waiters.length === 0) {
            this.active--
            return
        }
        const chosen = this.pick(this.waiters.map(waiter => waiter.tag))
        const index = chosen >= 0 && chosen < this.waiters.length ? chosen : 0
        // The slot is handed straight over, so `active` stays as it is.
        this.waiters.splice(index, 1)[0]!.grant()
    }

    /**
     * Reserves an interval slot before awaiting, so two callers that arrive in the same tick get
     * two different start times instead of both reading the same `Date.now()`.
     */
    private async pace(): Promise<void> {
        const min = this.spec.minIntervalMs
        if (min <= 0) return
        const now = Date.now()
        const start = Math.max(now, this.nextSlot)
        this.nextSlot = start + min
        const delay = start - now
        if (delay > 0) await sleep(delay)
    }
}

const firstComeFirstServed = (): number => 0

/** A standalone limiter. `pick` decides the order of waiters; first come, first served by default. */
export function createLimiter<Tag = undefined>(
    spec: LimitSpec,
    pick: WaiterPicker<Tag | undefined> = firstComeFirstServed,
): RequestLimiter<Tag> {
    return new QueueLimiter(spec, pick)
}

/** One limiter per purl type, created on first use and shared by every client of that type. */
export interface LimiterPool<Tag = undefined> {
    forType(type: string): RequestLimiter<Tag>
    /** Forgets every limiter, so the next use starts with an empty queue (tests). */
    reset(): void
}

/** `newPicker` is called once per limiter, so a picker may keep state of its own. */
export function createLimiterPool<Tag = undefined>(
    limits: EcosystemLimits,
    newPicker: () => WaiterPicker<Tag | undefined> = () => firstComeFirstServed,
): LimiterPool<Tag> {
    const limiters = new Map<string, RequestLimiter<Tag>>()
    return {
        forType(type) {
            let found = limiters.get(type)
            if (!found) {
                found = createLimiter(limitFor(limits, type), newPicker())
                limiters.set(type, found)
            }
            return found
        },
        reset() {
            limiters.clear()
        },
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
