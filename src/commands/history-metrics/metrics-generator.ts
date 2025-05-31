import {LibraryInfo} from "../../extension-points/registrar"
import semver from 'semver'
import { differenceInBusinessDays, parseISO } from "date-fns"

export function GrowthPatternMetric(data: CommitDependencyHistory): any {
  const summary: Record<string, any> = {};

  for (const [commitOid, { history }] of Object.entries(data)) {
    for (const entry of history) {
      if (!entry.date || !entry.project) continue;

      const key = `${entry.project}-${commitOid}`;
      if (!summary[key]) {
        summary[key] = {
          commit: commitOid,
          date: entry.date,
          project: entry.project,
          added: { direct: 0, transitive: 0 },
          removed: { direct: 0, transitive: 0 },
          modified: { direct: 0, transitive: 0 },
          totalChanges: 0
        };
      }

      const type = entry.type === 'transitive' ? 'transitive' : 'direct';

      if (entry.action === 'ADDED') {
        summary[key].added[type]++;
      } else if (entry.action === 'DELETED') {
        summary[key].removed[type]++;
      } else if (entry.action === 'MODIFIED') {
        summary[key].modified[type]++;
      }

      summary[key].totalChanges =
        summary[key].added.direct +
        summary[key].added.transitive +
        summary[key].removed.direct +
        summary[key].removed.transitive +
        summary[key].modified.direct +
        summary[key].modified.transitive;
    }
  }

  return Object.values(summary);
}

export function VersionChangeMetric(dependencies: Record<string, { history: any[] }>): any {
  const results: Record<
    string,
    {
      upgrades: number;
      downgrades: number;
    }
  > = {};

  for (const { history } of Object.values(dependencies)) {
    for (const entry of history) {
      if (
        entry.action !== 'MODIFIED' ||
        !entry.fromVersion ||
        !entry.toVersion ||
        !semver.valid(entry.fromVersion) ||
        !semver.valid(entry.toVersion) ||
        !entry.date
      ) {
        continue;
      }

      const dateKey = new Date(entry.date).toISOString().split('T')[0];
      const changeType = semver.gt(entry.toVersion, entry.fromVersion) ? 'upgrades' : 'downgrades';

      if (!results[dateKey]) {
        results[dateKey] = { upgrades: 0, downgrades: 0 };
      }

      results[dateKey][changeType]++;
    }
  }

  return results;
}

export function VulnerabilityFixBySeverityMetric(
  commitHistory: CommitDependencyHistory,
  libraryInfoMap: Record<string, { plugin: string; info: LibraryInfo }>
): Record<string, Record<string, number>> {
  const timeline: Record<string, Record<string, number>> = {};

  for (const [, commitEntry] of Object.entries(commitHistory)) {
    if (!commitEntry || !Array.isArray(commitEntry.history)) continue;
    const historyArray = commitEntry.history;

    for (const entry of historyArray) {
      if (
        entry.action !== 'MODIFIED' ||
        !entry.fromVersion ||
        !entry.toVersion ||
        !entry.date ||
        !entry.depinderDependencyName
      ) continue;

      const libKey = Object.keys(libraryInfoMap).find(k => k.endsWith(`:${entry.depinderDependencyName}`));
      if (!libKey) continue;

      const libInfo = libraryInfoMap[libKey];
      const libVulnerabilities = libInfo?.info?.vulnerabilities || [];

      const month = entry.date.slice(0, 7);

      for (const vuln of libVulnerabilities) {
        if (!vuln.vulnerableRange || !vuln.severity) continue;
        const cleanRange = vuln.vulnerableRange.replace(/,/g, ' ').trim();

        const wasVulnerable =
          semver.valid(entry.fromVersion) && semver.satisfies(entry.fromVersion, cleanRange);
        const stillVulnerable =
          semver.valid(entry.toVersion) && semver.satisfies(entry.toVersion, cleanRange);
        const isFixed = wasVulnerable && !stillVulnerable;

        if (isFixed) {
          if (!timeline[month]) timeline[month] = {};
          if (!timeline[month][vuln.severity]) timeline[month][vuln.severity] = 0;
          timeline[month][vuln.severity]++;
        }
      }
    }
  }

  return timeline;
}

// ISO-based maximum business day fix deadlines by severity
const severityFixTimeLimits: Record<string, number> = {
  CRITICAL: 7,    // Must be fixed within 7 business days
  HIGH: 15,       // Must be fixed within 15 business days
  MEDIUM: 30,     // Must be fixed within 30 business days
  LOW: 60         // Must be fixed within 60 business days
};

type SeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type FixCategory = 'fixedInTime' | 'fixedLate';
type TimelinessRecord = { fixedInTime: number; fixedLate: number };

export function VulnerabilityFixTimelinessMetric(
  commitHistory: CommitDependencyHistory,
  libraryInfoMap: Record<string, { plugin: string; info: LibraryInfo }>
): Record<string, Record<SeverityLevel, TimelinessRecord>> {
  const timeline: Record<string, Record<SeverityLevel, TimelinessRecord>> = {};
  const firstSeenMap: Record<string, Date> = {};

  for (const [, commitEntry] of Object.entries(commitHistory)) {
    if (!commitEntry?.history?.length) continue;

    for (const entry of commitEntry.history) {
      if (!entry.date || !entry.fromVersion || !entry.depinderDependencyName) continue;
      const libKey = Object.keys(libraryInfoMap).find(k => k.endsWith(`:${entry.depinderDependencyName}`));
      if (!libKey) continue;

      const vulnerabilities = libraryInfoMap[libKey]?.info?.vulnerabilities || [];
      const entryDate = parseISO(entry.date);

      for (const vuln of vulnerabilities) {
        if (!vuln.vulnerableRange || !vuln.severity) continue;
        const cleanRange = vuln.vulnerableRange.replace(/,/g, ' ').trim();
        const key = `${entry.depinderDependencyName}@@${cleanRange}`;

        const seenValid = semver.valid(entry.fromVersion) && semver.satisfies(entry.fromVersion, cleanRange);
        if (seenValid) {
          if (!firstSeenMap[key] || entryDate < firstSeenMap[key]) {
            firstSeenMap[key] = entryDate;
          }
        }

        const isFix = entry.action === 'MODIFIED' &&
          !!entry.toVersion &&
          semver.valid(entry.fromVersion) &&
          semver.valid(entry.toVersion) &&
          semver.satisfies(entry.fromVersion, cleanRange) &&
          !semver.satisfies(entry.toVersion, cleanRange);

        if (isFix) {
          const introducedDate = firstSeenMap[key] ?? entryDate;
          const daysToFix: number = differenceInBusinessDays(entryDate, introducedDate);
          const severity: SeverityLevel = vuln.severity.toUpperCase() as SeverityLevel;
          const fixDeadlineDays: number = severityFixTimeLimits[severity] ?? 999;
          const fixCategory: FixCategory = daysToFix <= fixDeadlineDays ? 'fixedInTime' : 'fixedLate';
          const month = entryDate.toISOString().slice(0, 7);

          if (!timeline[month]) timeline[month] = {} as Record<SeverityLevel, TimelinessRecord>;
          if (!timeline[month][severity]) timeline[month][severity] = { fixedInTime: 0, fixedLate: 0 };
          timeline[month][severity][fixCategory]++;
        }
      }
    }
  }

  return timeline;
}
