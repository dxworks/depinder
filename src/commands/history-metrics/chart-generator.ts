import { MetricOptions } from "./metrics-command";
import fs from "fs";

export async function generateHtmlChart(outputFile: string, charts: { data: any[], layout: any }[]) {
  const chartFile = outputFile.replace('.json', '.html');
  const html = generateMultiChartHtml(charts);

  fs.writeFileSync(chartFile, html);

  if (process.env.NODE_ENV !== 'test') {
    const open = (await import('open')).default;
    await open(chartFile);
  }
}

export function generateMultiChartHtml(charts: { data: any[]; layout: any }[]): string {
  const chartDivs = charts.map((_, index) =>
    `<div id="chart${index}" style="width:100%;height:500px;margin-bottom:80px;"></div>`
  ).join('\n');
  const scripts = charts.map((chart, index) => `
    Plotly.newPlot('chart${index}', ${JSON.stringify(chart.data)}, ${JSON.stringify(chart.layout)});
  `).join('\n');

  return `
  <html>
  <head>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <title>Dependency Metrics Dashboard</title>
    <style>
      body {
        font-family: sans-serif;
        padding: 20px;
      }
      h1 {
        text-align: center;
        margin-bottom: 40px;
      }
    </style>
  </head>
  <body>
    <h1>Dependency Metrics Dashboard</h1>
    ${chartDivs}
    <script>
      ${scripts}
    </script>
  </body>
  </html>
`;
}

export function generateGrowthPatternChartData(
  results: any[],
  options: MetricOptions
): { data: any[]; layout: any }[] {
  const sorted = [...results].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const xValues = sorted.map(r => {
    const date = new Date(r.date).toISOString().split('T')[0];
    const shortCommit = r.commit?.substring(0, 7) ?? '';
    return `${date} (${shortCommit})`;
  });

  return options.chartType.map(type => {
    const traceType = type === 'line' ? 'scatter' : 'bar';
    const isStacked = type === 'stacked';
    const isArea = type === 'stacked-area';

    const commonTraceProps = {
      type: isArea ? 'scatter' : traceType,
      mode: traceType === 'scatter' ? 'lines+markers' : undefined,
      fill: isArea ? 'tonexty' : undefined,
      stackgroup: isArea ? 'one' : undefined
    };

    const traceDirectAdded = {
      x: xValues,
      y: sorted.map(r => r.added?.direct ?? 0),
      name: 'Direct Added',
      ...commonTraceProps
    };

    const traceTransitiveAdded = {
      x: xValues,
      y: sorted.map(r => r.added?.transitive ?? 0),
      name: 'Transitive Added',
      ...commonTraceProps
    };

    const traceDirectRemoved = {
      x: xValues,
      y: sorted.map(r => r.removed?.direct ?? 0),
      name: 'Direct Removed',
      ...commonTraceProps
    };

    const traceTransitiveRemoved = {
      x: xValues,
      y: sorted.map(r => r.removed?.transitive ?? 0),
      name: 'Transitive Removed',
      ...commonTraceProps
    };

    const traceDirectModified = {
      x: xValues,
      y: sorted.map(r => r.modified?.direct ?? 0),
      name: 'Direct Modified',
      ...commonTraceProps
    };

    const traceTransitiveModified = {
      x: xValues,
      y: sorted.map(r => r.modified?.transitive ?? 0),
      name: 'Transitive Modified',
      ...commonTraceProps
    };

    const traceTotalChanges = {
      x: xValues,
      y: sorted.map(r => r.totalChanges ?? 0),
      name: 'Total Changes',
      type: 'scatter',
      mode: 'lines+markers',
      line: { width: 2, dash: 'dot', color: '#a63603' },
      marker: { symbol: 'circle-open', size: 6 },
      yaxis: 'y2'
    };

    const traces = [
      traceDirectAdded,
      traceTransitiveAdded,
      traceDirectRemoved,
      traceTransitiveRemoved,
      traceDirectModified,
      traceTransitiveModified,
      traceTotalChanges
    ];

    const nonZeroTraces = traces.filter(trace => trace.y.some((y: number) => y > 0));

    const layout = {
      title: `📈 Growth Pattern of Dependencies Over Time (${type})`,
      barmode: isStacked ? 'stack' : undefined,
      xaxis: {
        title: 'Commit (Date)',
        tickangle: -45,
        automargin: true
      },
      yaxis: {
        title: 'Dependency Change Count',
        side: 'left'
      },
      yaxis2: {
        title: 'Total',
        overlaying: 'y',
        side: 'right',
        showgrid: false
      },
      margin: {
        l: 50,
        r: 50,
        t: 80,
        b: 120
      }
    };

    return {
      data: nonZeroTraces,
      layout
    };
  });
}

export function generateVersionChangeChartData(
  results: Record<string, Record<string, {
    upgrades: { from: string; to: string; date: string }[];
    downgrades: { from: string; to: string; date: string }[];
  }>>,
  options: MetricOptions
): { data: any[]; layout: any }[] {
  const charts: { data: any[]; layout: any }[] = [];

  // Prepare project-based daily counts
  const projectChartData: {
    [project: string]: { [date: string]: { upgrades: number; downgrades: number } }
  } = {};

  for (const [project, deps] of Object.entries(results)) {
    if (!projectChartData[project]) projectChartData[project] = {};

    for (const dep of Object.values(deps)) {
      for (const { date } of dep.upgrades) {
        const day = new Date(date).toISOString().split('T')[0];
        projectChartData[project][day] ??= { upgrades: 0, downgrades: 0 };
        projectChartData[project][day].upgrades += 1;
      }
      for (const { date } of dep.downgrades) {
        const day = new Date(date).toISOString().split('T')[0];
        projectChartData[project][day] ??= { upgrades: 0, downgrades: 0 };
        projectChartData[project][day].downgrades += 1;
      }
    }
  }

  // Generate chart for each chartType
  for (const chartType of options.chartType) {
    const isLine = chartType === 'line';
    const isStacked = chartType === 'stacked';
    const isArea = chartType === 'stacked-area';

    for (const [project, dateCounts] of Object.entries(projectChartData)) {
      const sortedDates = Object.keys(dateCounts).sort();
      const x = sortedDates;
      const upgrades = sortedDates.map(date => dateCounts[date].upgrades);
      const downgrades = sortedDates.map(date => dateCounts[date].downgrades);

      const baseType = isLine || isArea ? 'scatter' : 'bar';

      const commonTraceProps: Partial<any> = {
        type: baseType,
        mode: isLine || isArea ? 'lines+markers' : undefined,
        fill: isArea ? 'tonexty' : undefined,
        stackgroup: isArea ? 'one' : undefined
      };

      const data = [
        {
          x,
          y: upgrades,
          name: 'Upgrades',
          marker: { color: 'green' },
          ...commonTraceProps
        },
        {
          x,
          y: downgrades,
          name: 'Downgrades',
          marker: { color: 'red' },
          ...commonTraceProps
        }
      ];

      const layout = {
        title: `📦 Version Changes in "${project}" (${chartType})`,
        barmode: isStacked ? 'stack' : 'group',
        xaxis: {
          title: 'Date',
          tickangle: -45
        },
        yaxis: {
          title: 'Change Count'
        },
        margin: {
          l: 50,
          r: 50,
          t: 60,
          b: 100
        }
      };

      charts.push({ data, layout });
    }
  }

  return charts;
}

