import { runMetrics } from "../src/commands/history-metrics/metrics-command";

describe('test version change metric generation', () => {
  it('should generate the version-changes metric', async () => {
    await runMetrics('/Users/avram/OutputReportsOfHistory', {
      results: 'results-charts-version-changes',
      metric: 'version-changes',
      chart: true,
      chartType: ['line', 'bar', 'stacked', 'stacked-area'],
      inputFiles: [
        'dependency-history-java-2025-04-21T19-40-53-470Z'
      ],
      plugin: 'java'
    });

    console.log('✅ Done generating version-changes metric.');
  });
});
