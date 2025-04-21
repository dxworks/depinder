import fs from 'fs'
import path from 'path'
import {GrowthPatternMetric } from "./metrics-generator"
import {Command} from "commander"
import {generateGrowthPatternChartData, generateHtmlChart} from "./chart-generator"

export const runMetricsCommand = new Command()
  .name('metrics')
  .description('Run metrics on dependency history and optionally generate charts')
  .argument('<historyFolder>', 'Folder where the input files are located')
  .option('--results, -r <resultsFolder>', 'The results folder', 'results')
  .option('--metric <metricType>', 'Metric type to calculate', 'addition-removal')
  .option('--chart', 'Generate chart visualization', false)
  .option('--chartType <chartType>', 'Chart type (bar | line | stacked)', 'bar')
  .option('--inputFiles <inputFiles...>', 'List of input files to use (without .json)')
  .action(runMetrics);

export interface MetricOptions {
  results: string;
  metric: string;
  chart: boolean;
  chartType: ('line' | 'bar' | 'stacked' | 'stacked-area')[];
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
      const chartConfigs = getChartDataForMetric(options.metric, results, options);
      if (chartConfigs && chartConfigs.length > 0) {
        await generateHtmlChart(outputFile, chartConfigs);
      } else {
        console.warn(`⚠️  No chart generator defined for metric '${options.metric}'. Skipping chart.`);
      }
    }

    console.log(`✅ Metric calculated for ${filePath} and chart generated (if requested).`);
  }
}

function getMetricProcessor(metricType: string): ((data: CommitDependencyHistory) => any) | undefined {
  switch (metricType) {
    case 'growth-pattern':
      return GrowthPatternMetric;
    default:
      return undefined;
  }
}

function getRequiredInputFilesForMetric(metricType: string): string[] {
  switch (metricType) {
    case 'growth-pattern':
      return ['commit-dependency-history'];
    default:
      return [];
  }
}

function getChartDataForMetric(
  metricType: string,
  results: any[],
  options: MetricOptions
): { data: any[]; layout: any }[] | null {
  switch (metricType) {
    case 'growth-pattern':
      return generateGrowthPatternChartData(results, options);
    default:
      return null;
  }
}
