import semver from "semver/preload";

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
