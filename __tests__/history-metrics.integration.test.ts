import { runMetrics } from "../src/commands/history-metrics/metrics-command";

describe('test general metric and chart generation', () => {
  it('should generate the metric and corresponding chart', async () => {
    await runMetrics('/Users/avram/OutputReportsOfHistory', {
      results: 'results-addition-removal',
      metric: 'addition-removal',
      chart: true,
      chartType: 'stacked',
      title: '📦 Additions & Removals Over Time',
      inputFiles: ['dependency-history-java-2025-04-20T21-17-13-671Z',
        'commit-dependency-history-java-2025-04-20T21-17-13-675Z',
        'library-info-2025-04-20T21-17-21-745Z']
    });

    console.log('✅ Done generating metric + chart.');
  });
});

