import { runMetrics } from "../src/commands/history-metrics/metrics-command";

describe('test version change metric generation', () => {
  it('should generate the version-changes metric', async () => {
    await runMetrics('/Users/avram/OutputReportsOfHistory', {
      results: 'results-version-changes',
      metric: 'version-changes',
      chart: true,
      chartType: ['line', 'bar', 'stacked', 'stacked-area'],
      inputFiles: ['dependency-history-2025-05-03T20-57-12-360Z',
      'commit-dependency-history-2025-05-03T20-57-12-360Z']
    });

    console.log('✅ Done generating version-changes metric.');
  });
});
