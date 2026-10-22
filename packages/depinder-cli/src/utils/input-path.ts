/** Imported logical paths use the scanning host's separators. Keep them
 * slash-separated; leave native filesystem paths unchanged. */
export function normalizeInputPath(value: string): string {
    return value.replace(/\\/g, '/')
}
