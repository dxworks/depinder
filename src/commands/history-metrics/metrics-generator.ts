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


export function VersionChangeMetric(data: Record<string, { history: any[] }>) {
  const result: Record<string, Record<string, {
    upgrades: { from: string, to: string, date: string }[],
    downgrades: { from: string, to: string, date: string }[]
  }>> = {};

  for (const [depName, depInfo] of Object.entries(data)) {
    for (const entry of depInfo.history) {
      if (entry.action === 'MODIFIED') {
        const { fromVersion, toVersion, project, date } = entry;

        if (!result[project]) {
          result[project] = {};
        }
        if (!result[project][depName]) {
          result[project][depName] = { upgrades: [], downgrades: [] };
        }

        if (semver.valid(fromVersion) && semver.valid(toVersion)) {
          if (semver.gt(toVersion, fromVersion)) {
            result[project][depName].upgrades.push({ from: fromVersion, to: toVersion, date });
          } else if (semver.lt(toVersion, fromVersion)) {
            result[project][depName].downgrades.push({ from: fromVersion, to: toVersion, date });
          }
        }
      }
    }
  }

  return result;
}

