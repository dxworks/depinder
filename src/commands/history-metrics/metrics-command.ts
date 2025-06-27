import fs from 'fs'
import path from 'path'
import {Command} from 'commander'
import {
  GrowthPatternMetric,
  VersionChangeMetric,
  VulnerabilityFixBySeverityMetric,
  VulnerabilityFixTimelinessMetric
} from './metrics-generator';
import {
  generateGrowthPatternChartData,
  generateVersionChangeChartData,
  generateHtmlChart,
  generateVulnerabilityFixBySeverityChartData,
  generateVulnerabilityFixTimelinessChartData
} from './chart-generator'
import os from "os";

export const metricsCommand = new Command()
  .name('metrics')
  .description('Run metrics on dependency history and optionally generate charts')
  .option('--inputDir <inputDir>', 'Directory to look for input .json files', '')
  .option('--results <resultsFolder>', 'Folder to save results in', 'results')
  .option('--metric <metricType>', 'Metric type to calculate')
  .option('--chart', 'Generate chart visualization', false)
  .option('--chartType <chartType>', 'Chart types to generate (bar, line, stacked, stacked-area)')
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

type MetricType =
  | 'growth-pattern'
  | 'version-changes'
  | 'vulnerability-fix-by-severity'
  | 'vulnerability-fix-timeliness';

interface MetricConfig {
  processor: (data: any, libraryInfo?: any) => any;
  requiredPrefixes: string[];
  chartGenerator?: (results: any, options: MetricOptions) => { data: any[]; layout: any }[];
}

const metricsRegistry: Record<MetricType, MetricConfig> = {
  'growth-pattern': {
    processor: GrowthPatternMetric,
    requiredPrefixes: ['commit-dependency-history'],
    chartGenerator: generateGrowthPatternChartData
  },
  'version-changes': {
    processor: VersionChangeMetric,
    requiredPrefixes: ['dependency-history'],
    chartGenerator: generateVersionChangeChartData
  },
  'vulnerability-fix-by-severity': {
    processor: VulnerabilityFixBySeverityMetric,
    requiredPrefixes: ['commit-dependency-history', 'library-info'],
    chartGenerator: generateVulnerabilityFixBySeverityChartData
  },
  'vulnerability-fix-timeliness': {
    processor: VulnerabilityFixTimelinessMetric,
    requiredPrefixes: ['commit-dependency-history', 'library-info'],
    chartGenerator: generateVulnerabilityFixTimelinessChartData
  }
};

function isValidMetricType(metric: string): metric is MetricType {
  return metric in metricsRegistry;
}

export async function runMetrics(options: MetricOptions): Promise<void> {
  const homeDir = os.homedir();
  const metricType = options.metric;

  // Ensure chartType is always an array with a default value
  if (!options.chartType || !Array.isArray(options.chartType)) {
    options.chartType = options.chartType ? [options.chartType as any] : ['bar'];
  }

  console.log('Chart types:', options.chartType);

  if (!isValidMetricType(metricType)) {
    console.error(`❌ Unknown metric type: ${metricType}`);
    return;
  }

  const config = metricsRegistry[metricType];

  if (!options.inputFiles?.length) {
    console.error('❌ No input files provided.');
    return;
  }

  const inputBase = path.join(homeDir, options.inputDir || '');
  const outputBase = path.join(homeDir, options.results);
  fs.mkdirSync(outputBase, { recursive: true });

  let libraryInfo: any = undefined;
  const libraryInfoFile = options.inputFiles.find(file => file.startsWith('library-info'));

  if (libraryInfoFile) {
    const libCandidates = [
      path.join(inputBase, libraryInfoFile),
      path.join(inputBase, `${libraryInfoFile}.json`)
    ];
    const libPath = libCandidates.find(p => fs.existsSync(p));
    if (libPath) {
      const libContent = fs.readFileSync(libPath, 'utf-8');
      libraryInfo = JSON.parse(libContent);
    } else {
      console.warn(`⚠️ Specified library-info file not found for: ${libraryInfoFile}`);
    }
  }

  const mainDataFile = options.inputFiles.find(file =>
    config.requiredPrefixes.some(prefix => file.startsWith(prefix) && prefix !== 'library-info')
  );

  if (!mainDataFile) {
    console.warn(`⚠️ No valid main data file found. Expected prefix: ${config.requiredPrefixes.join(', ')}`);
    return;
  }

  const fileName = mainDataFile.endsWith('.json') ? mainDataFile : `${mainDataFile}.json`;
  const filePath = path.join(inputBase, fileName);

  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️ File not found: ${filePath}`);
    return;
  }

  const fileContents = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContents);
  const results = config.processor(data, libraryInfo);

  const outputFile = path.join(outputBase, `${metricType}-metric.json`);
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

  if (options.chart && config.chartGenerator) {
    const chartConfigs = config.chartGenerator(results, options);
    if (chartConfigs?.length) {
      await generateHtmlChart(outputFile, chartConfigs);
    } else {
      console.warn(`⚠️ No chart data generated for metric '${metricType}'.`);
    }
  }

  console.log(`✅ Metric calculated for ${filePath} and chart generated (if requested).`);
}
