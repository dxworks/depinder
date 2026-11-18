import moment from 'moment'
import {isBranch, isPrerelease} from '@depinder/core'
import {LibraryInfo, usedVersionTimestamp} from '../extension-points/library-info'
import {isoDate} from '../utils/iso-date'
import {comparatorForPurlType} from '../versioning'

export interface ReleaseMeasurements {
    reportDate: string
    latestVersion?: string
    latestDate?: string
    recentVersion?: string
    recentDate?: string
    upgradeLag?: number
    inactivity?: number
}

/** Select comparison releases without changing the registry's legacy latest designation. */
export function releaseMeasurements(library: LibraryInfo | undefined, used: string, purlType: string, asOf: Date): ReleaseMeasurements {
    const reportDate = asOf.toISOString().slice(0, 10)
    const eligible = (library?.versions ?? []).filter(version =>
        !version.yanked && !isBranch(purlType, version.version))
    const stable = eligible.filter(version => !(version.prerelease ?? isPrerelease(purlType, version.version)))
    const candidates = stable.length ? stable : eligible
    const compare = comparatorForPurlType(purlType)
    const latest = [...candidates].sort((a, b) => compare(a.version, b.version)).at(-1)
    const latestDate = isoDate(latest?.timestamp)
    const usedDate = isoDate(usedVersionTimestamp(library?.versions, used))
    const recent = candidates.length === 1 ? candidates[0] : candidates.length && candidates.every(version => isoDate(version.timestamp))
        ? [...candidates].sort((a, b) => a.timestamp - b.timestamp || compare(a.version, b.version)).at(-1)
        : undefined
    const recentDate = isoDate(recent?.timestamp)
    return {
        reportDate, latestVersion: latest?.version, latestDate, recentVersion: recent?.version, recentDate,
        upgradeLag: latestDate && usedDate
            ? Math.max(0, moment.utc(latestDate).diff(moment.utc(usedDate), 'months')) : undefined,
        inactivity: recentDate ? moment.utc(reportDate).diff(moment.utc(recentDate), 'months') : undefined,
    }
}
