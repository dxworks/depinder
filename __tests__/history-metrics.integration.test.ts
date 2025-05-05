import { runMetrics } from "../src/commands/history-metrics/metrics-command";

describe('test version change metric generation', () => {
  it('should generate the version-changes metric', async () => {
    await runMetrics('/Users/avram', {
      inputDir: 'results-history',
      results: 'results-version-changes',
      metric: 'version-changes',
      chart: true,
      chartType: ['line', 'bar', 'stacked', 'stacked-area'],
      inputFiles: [
        'commit-dependency-history-2025-05-05T20-14-51-048Z',
        'dependency-history-2025-05-05T20-14-51-048Z'
      ]
    });

    console.log('✅ Done generating growth-pattern metric.');
  });
});
