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

  const isSemverVulnerable = (version: string | undefined, range: string): boolean =>
    !!version && semver.valid(version) !== null && semver.satisfies(version, range);

  for (const [, commitEntry] of Object.entries(commitHistory)) {
    if (!commitEntry?.history?.length) continue;
    for (const entry of commitEntry.history) {
      if (!entry.date || !entry.depinderDependencyName) continue;
      const libKey = Object.keys(libraryInfoMap).find(k =>
        k.endsWith(`:${entry.depinderDependencyName}`)
      );
      if (!libKey) continue;
      const vulnerabilities = libraryInfoMap[libKey]?.info?.vulnerabilities || [];
      const month = entry.date.slice(0, 7);
      for (const vuln of vulnerabilities) {
        if (!vuln.vulnerableRange || !vuln.severity) continue;
        const cleanRange = vuln.vulnerableRange.replace(/,/g, ' ').trim();
        const severity = vuln.severity;
        let isFixed = false;
        if (entry.action === 'MODIFIED') {
          const wasVulnerable = isSemverVulnerable(entry.fromVersion, cleanRange);
          const stillVulnerable = isSemverVulnerable(entry.toVersion, cleanRange);
          isFixed = wasVulnerable && !stillVulnerable;
        }
        if (entry.action === 'DELETED') {
          isFixed = isSemverVulnerable(entry.version, cleanRange);
        }
        if (isFixed) {
          if (!timeline[month]) timeline[month] = {};
          timeline[month][severity] = (timeline[month][severity] || 0) + 1;
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

export function VulnerabilityFixTimelinessMetric(
  commitHistory: CommitDependencyHistory,
  libraryInfoMap: Record<string, { plugin: string; info: LibraryInfo }>
): Record<string, Record<string, any>> {
  const timeline: Record<string, Record<string, any>> = {};
  const firstSeenMap: Record<string, Date> = {};

  for (const [, commitEntry] of Object.entries(commitHistory)) {
    if (!commitEntry?.history?.length) continue;

    for (const entry of commitEntry.history) {
      if (!entry.date || !entry.depinderDependencyName) continue;
      const libKey = Object.keys(libraryInfoMap).find(k =>
        k.endsWith(`:${entry.depinderDependencyName}`)
      );
      if (!libKey) continue;

      const vulnerabilities = libraryInfoMap[libKey]?.info?.vulnerabilities || [];
      const entryDate = parseISO(entry.date);
      const month = entryDate.toISOString().slice(0, 7);

      for (const vuln of vulnerabilities) {
        if (!vuln.vulnerableRange || !vuln.severity) continue;
        const cleanRange = vuln.vulnerableRange.replace(/,/g, ' ').trim();
        const key = `${entry.depinderDependencyName}@@${cleanRange}`;
        const versionToCheck =
          entry.action === 'MODIFIED' ? entry.fromVersion :
            entry.action === 'DELETED' ? entry.version :
              entry.action === 'ADDED' ? entry.version :
                undefined;
        const isVersionVulnerable =
          !!versionToCheck && semver.valid(versionToCheck) && semver.satisfies(versionToCheck, cleanRange);
        if (isVersionVulnerable) {
          if (!firstSeenMap[key] || entryDate < firstSeenMap[key]) {
            firstSeenMap[key] = entryDate;
          }
          if (!timeline[month]) timeline[month] = { totalVulnerabilities: 0 };
          timeline[month].totalVulnerabilities++;
        }
        const isFixViaModification =
          entry.action === 'MODIFIED' &&
          !!entry.toVersion &&
          semver.valid(entry.toVersion) &&
          isVersionVulnerable &&
          !semver.satisfies(entry.toVersion, cleanRange);
        const isFixViaDeletion =
          entry.action === 'DELETED' &&
          isVersionVulnerable;
        const isFix = isFixViaModification || isFixViaDeletion;
        if (isFix) {
          const introducedDate = firstSeenMap[key] ?? entryDate;
          const daysToFix = differenceInBusinessDays(entryDate, introducedDate);
          const severity = vuln.severity.toUpperCase() as SeverityLevel;
          const fixDeadlineDays: any = severityFixTimeLimits[severity] ?? 999;
          const fixCategory: FixCategory = daysToFix <= fixDeadlineDays ? 'fixedInTime' : 'fixedLate';
          if (!timeline[month]) timeline[month] = { totalVulnerabilities: 0 };
          if (!timeline[month][severity]) timeline[month][severity] = { fixedInTime: 0, fixedLate: 0 };
          timeline[month][severity][fixCategory]++;
        }
      }
    }
  }

  return timeline;
}
