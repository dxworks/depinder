/** `Promise.all` with a ceiling on how many are in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
        for (;;) {
            const index = next++
            if (index >= items.length) return
            results[index] = await fn(items[index]!)
        }
    })
    await Promise.all(workers)
    return results
}
