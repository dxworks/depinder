/**
 * The two CVSS 3.x sub-scores Black Duck prints next to `Base score`: `Exploitability` and
 * `Impact`, computed from the vector with the formulas of the CVSS 3.1 specification (section 7.1;
 * 3.0 uses the same numbers). Black Duck rounds both to one decimal — `3.9` for the ubiquitous
 * `AV:N/AC:L/PR:N/UI:N`. A CVSS 4 vector has no such split, and Black Duck writes none for it.
 */

const AV: Record<string, number> = {N: 0.85, A: 0.62, L: 0.55, P: 0.2}
const AC: Record<string, number> = {L: 0.77, H: 0.44}
const PR_UNCHANGED: Record<string, number> = {N: 0.85, L: 0.62, H: 0.27}
const PR_CHANGED: Record<string, number> = {N: 0.85, L: 0.68, H: 0.5}
const UI: Record<string, number> = {N: 0.85, R: 0.62}
const CIA: Record<string, number> = {H: 0.56, L: 0.22, N: 0}

export interface CvssSubScores {
    exploitability: number
    impact: number
}

function metrics(vector: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const part of vector.split('/')) {
        const [k, v] = part.split(':')
        if (k && v) out[k] = v
    }
    return out
}

/** `undefined` for anything but a complete CVSS 3.x base vector. */
export function cvss3SubScores(vector: string | undefined): CvssSubScores | undefined {
    if (!vector || !vector.startsWith('CVSS:3')) return undefined
    const m = metrics(vector)
    const changed = m.S === 'C'
    const av = AV[m.AV], ac = AC[m.AC], ui = UI[m.UI]
    const pr = (changed ? PR_CHANGED : PR_UNCHANGED)[m.PR]
    const c = CIA[m.C], i = CIA[m.I], a = CIA[m.A]
    if ([av, ac, pr, ui, c, i, a].some(it => it === undefined) || (m.S !== 'U' && m.S !== 'C')) return undefined

    const exploitability = 8.22 * av * ac * pr * ui
    const iss = 1 - (1 - c) * (1 - i) * (1 - a)
    const impact = changed
        ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
        : 6.42 * iss
    // Impact can go slightly negative for an all-None vector; the specification treats it as 0.
    return {exploitability: round1(exploitability), impact: round1(Math.max(impact, 0))}
}

function round1(n: number): number {
    return Math.round(n * 10) / 10
}
