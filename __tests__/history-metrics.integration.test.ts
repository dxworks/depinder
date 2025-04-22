import { runMetrics } from "../src/commands/history-metrics/metrics-command";

describe('test metric and chart generation', () => {
  it('should generate the metric and corresponding chart', async () => {
    await runMetrics('/Users/avram/OutputReportsOfHistory', {
      results: 'results-charts',
      metric: 'growth-pattern',
      chart: true,
      chartType: ['line', 'bar', 'stacked', 'stacked-area'],
      inputFiles: [
        'dependency-history-java-2025-04-21T19-40-53-470Z',
        'commit-dependency-history-java-2025-04-21T19-40-53-473Z',
        'library-info-2025-04-21T19-41-01-669Z'
      ],
      plugin: 'java'
    });

    console.log('✅ Done generating metric + chart.');
  });
});

