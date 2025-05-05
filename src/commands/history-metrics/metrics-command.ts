import fs from 'fs'
import path from 'path'
import {GrowthPatternMetric, VersionChangeMetric} from './metrics-generator';
import {Command} from 'commander';
import {generateGrowthPatternChartData, generateHtmlChart, generateVersionChangeChartData} from './chart-generator';

export const runMetricsCommand = new Command()
  .name('metrics')
  .description('Run metrics on dependency history and optionally generate charts')
  .argument('<historyFolder>', 'Folder where the base input/output folders are located')
  .option('--inputDir <inputDir>', 'Directory to look for input .json files', '')
  .option('--results, -r <resultsFolder>', 'Folder to save results in', 'results')
  .option('--metric <metricType>', 'Metric type to calculate', 'addition-removal')
  .option('--chart', 'Generate chart visualization', false)
  .option('--chartType <chartType>', 'Chart type (bar | line | stacked)', 'bar')
  .option('--inputFiles <inputFiles...>', 'List of input files to use (without .json)')
  .action(runMetrics);

export interface MetricOptions {
  inputDir: string;
  results: string;
  metric: string;
  chart: boolean;
  chartType: ('line' | 'bar' | 'stacked' | 'stacked-area')[];
  inputFiles: string[];
}

export async function runMetrics(historyFolder: string, options: MetricOptions): Promise<void> {
  const metricProcessor = getMetricProcessor(options.metric);
  if (!metricProcessor) {
    console.error(`❌ Unknown metric type: ${options.metric}`);
    return;
  }

  const requiredPrefixes = getRequiredInputFilesForMetric(options.metric);
  if (!options.inputFiles || options.inputFiles.length === 0) {
    console.error('❌ No input files provided.');
    return;
  }

  const validInputFiles = options.inputFiles.filter(file =>
    requiredPrefixes.some(prefix => file.startsWith(prefix))
  );

  if (validInputFiles.length === 0) {
    console.warn(`⚠️ No input files match the required prefixes: ${requiredPrefixes.join(', ')}`);
    return;
  }

  const inputBase = path.join(historyFolder, options.inputDir || '');
  const outputBase = path.join(historyFolder, options.results);
  fs.mkdirSync(outputBase, { recursive: true });

  for (const relativeName of validInputFiles) {
    const fileName = relativeName.endsWith('.json') ? relativeName : `${relativeName}.json`;
    const filePath = path.join(inputBase, fileName);

    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ File not found: ${filePath}`);
      continue;
    }

    const fileContents = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(fileContents);
    const results = metricProcessor(data);

    const outputFile = path.join(outputBase, `${path.parse(fileName).name}-${options.metric}-metric.json`);
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

    if (options.chart) {
      const chartConfigs = getChartDataForMetric(options.metric, results, options);
      if (chartConfigs?.length) {
        await generateHtmlChart(outputFile, chartConfigs);
      } else {
        console.warn(`⚠️ No chart generator defined for metric '${options.metric}'. Skipping chart.`);
      }
    }

    console.log(`✅ Metric calculated for ${filePath} and chart generated (if requested).`);
  }
}

function getMetricProcessor(metricType: string): ((data: any) => any) | undefined {
  switch (metricType) {
    case 'growth-pattern':
      return GrowthPatternMetric;
    case 'version-changes':
      return VersionChangeMetric;
    default:
      return undefined;
  }
}

function getRequiredInputFilesForMetric(metricType: string): string[] {
  switch (metricType) {
    case 'growth-pattern':
      return ['commit-dependency-history'];
    case 'version-changes':
      return ['dependency-history'];
    default:
      return [];
  }
}

function getChartDataForMetric(
  metricType: string,
  results: any,
  options: MetricOptions
): { data: any[]; layout: any }[] | null {
  switch (metricType) {
    case 'growth-pattern':
      return generateGrowthPatternChartData(results, options);
    case 'version-changes':
      return generateVersionChangeChartData(results, options);
    default:
      return null;
  }
}

