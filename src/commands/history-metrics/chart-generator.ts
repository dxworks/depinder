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
      y: (() => {
        const totals: number[] = [];
        let runningTotal = 0;
        for (const r of sorted) {
          runningTotal += r.totalChanges ?? 0;
          totals.push(runningTotal);
        }
        return totals;
      })(),
      name: 'Total Changes (Cumulative)',
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
        title: 'Total (Cumulative)',
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
  results: Record<string, { upgrades: number; downgrades: number }>,
  options: MetricOptions
): { data: any[]; layout: any }[] {
  const sortedDates = Object.keys(results).sort();
  const upgrades = sortedDates.map(date => results[date].upgrades);
  const downgrades = sortedDates.map(date => results[date].downgrades);

  return options.chartType.map(type => {
    const isLine = type === 'line';
    const isStacked = type === 'stacked';
    const isArea = type === 'stacked-area';

    const traceType = isLine || isArea ? 'scatter' : 'bar';
    const commonTraceProps = {
      type: traceType,
      mode: isLine ? 'lines+markers' : undefined,
      fill: isArea ? 'tonexty' : undefined,
      stackgroup: isArea ? 'one' : undefined
    };

    const upgradeTrace = {
      x: sortedDates,
      y: upgrades,
      name: 'Upgrades',
      ...commonTraceProps
    };

    const downgradeTrace = {
      x: sortedDates,
      y: downgrades,
      name: 'Downgrades',
      ...commonTraceProps
    };

    const layout = {
      title: `🔄 Version Changes Over Time (${type})`,
      barmode: isStacked ? 'stack' : (traceType === 'bar' ? 'group' : undefined),
      xaxis: {
        title: 'Date',
        tickangle: -45,
        automargin: true
      },
      yaxis: {
        title: 'Change Count'
      },
      margin: {
        l: 50,
        r: 30,
        t: 60,
        b: 120
      }
    };

    return {
      data: [upgradeTrace, downgradeTrace],
      layout
    };
  });
}

