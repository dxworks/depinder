export function AdditionRemovalMetric(data: CommitDependencyHistory): any {
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
        };
      }

      if (entry.action === 'ADDED') {
        entry.type === 'direct'
          ? summary[key].added.direct++
          : summary[key].added.transitive++;
      }

      if (entry.action === 'DELETED') {
        entry.type === 'direct'
          ? summary[key].removed.direct++
          : summary[key].removed.transitive++;
      }
    }
  }
  return Object.values(summary);
}
