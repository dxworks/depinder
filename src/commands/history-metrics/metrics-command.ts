import fs from 'fs';
import path from 'path';
import { AdditionRemovalMetric } from "./metrics";
import { Command } from "commander";

export const runMetricsCommand = new Command()
  .name('metrics')
  .description('Run metrics on dependency history and optionally generate charts')
  .argument('<historyFolder>', 'Folder where the input files are located')
  .option('--results, -r <resultsFolder>', 'The results folder', 'results')
  .option('--metric <metricType>', 'Metric type to calculate', 'addition-removal')
  .option('--chart', 'Generate chart visualization', false)
  .option('--chartType <chartType>', 'Chart type (bar | line | stacked)', 'bar')
  .option('--title <title>', 'Optional chart title')
  .option('--inputFiles <inputFiles...>', 'List of input files to use (without .json)')
  .action(runMetrics);

interface MetricOptions {
  results: string;
  metric: string;
  chart: boolean;
  chartType: 'bar' | 'line' | 'stacked';
  title?: string;
  inputFiles: string[];
}

export async function runMetrics(folder: string, options: MetricOptions): Promise<void> {
  const metricProcessor = getMetricProcessor(options.metric);
  if (!metricProcessor) {
    console.error(`❌ Unknown metric type: ${options.metric}`);
    return;
  }

  if (options.inputFiles.length === 0) {
    console.error('❌ No valid input files provided.');
    return;
  }

  const requiredFiles = getRequiredInputFilesForMetric(options.metric);

  for (const relativePath of options.inputFiles) {
    const fileName = relativePath.endsWith('.json') ? relativePath : `${relativePath}.json`;
    const fileBase = path.basename(fileName);
    if (!requiredFiles.some(prefix => fileBase.startsWith(prefix))) {
      console.log(`ℹ️  Skipping file '${fileBase}' — not required for metric '${options.metric}'.`);
      continue;
    }

    const filePath = path.join(folder, fileName);
    const fileContents = fs.readFileSync(filePath, 'utf-8');
    const data: CommitDependencyHistory = JSON.parse(fileContents);

    const results = metricProcessor(data);

    const resultsFolder = path.join(path.dirname(filePath), options.results);
    fs.mkdirSync(resultsFolder, { recursive: true });
    const outputFile = path.join(resultsFolder, `${path.parse(filePath).name}-${options.metric}-metric.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

    if (options.chart) {
      await generateHtmlChart(outputFile, results, options);
    }

    console.log(`✅ Metric calculated for ${filePath} and chart generated (if requested).`);
  }
}

function getMetricProcessor(metricType: string): ((data: CommitDependencyHistory) => any) | undefined {
  switch (metricType) {
    case 'addition-removal':
      return AdditionRemovalMetric;
    default:
      return undefined;
  }
}

function getRequiredInputFilesForMetric(metricType: string): string[] {
  switch (metricType) {
    case 'addition-removal':
      return ['commit-dependency-history-java'];
    default:
      return [];
  }
}

async function generateHtmlChart(outputFile: string, results: any[], options: MetricOptions) {
  const chartFile = outputFile.replace('.json', '.html');
  const traceAdded = {
    x: results.map((r: any) => r.date),
    y: results.map((r: any) => r.added.direct + r.added.transitive),
    name: 'Added',
    type: options.chartType
  };
  const traceRemoved = {
    x: results.map((r: any) => r.date),
    y: results.map((r: any) => r.removed.direct + r.removed.transitive),
    name: 'Removed',
    type: options.chartType
  };
  const dataTraces = [traceAdded, traceRemoved];
  const layout = {
    title: options.title || 'Dependency Changes Over Time',
    barmode: options.chartType === 'stacked' ? 'stack' : undefined
  };
  const html = `
    <html>
    <head>
      <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    </head>
    <body>
      <div id="chart"></div>
      <script>
        const data = ${JSON.stringify(dataTraces)};
        const layout = ${JSON.stringify(layout)};
        Plotly.newPlot('chart', data, layout);
      </script>
    </body>
    </html>`;

  fs.writeFileSync(chartFile, html);
  if (process.env.NODE_ENV !== 'test') {
    const open = (await import('open')).default;
    await open(chartFile);
  }
}
