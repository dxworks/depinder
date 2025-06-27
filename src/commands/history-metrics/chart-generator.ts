import { MetricOptions } from "./metrics-command";
import fs from "fs";

export async function generateHtmlChart(outputFile: string, charts: { data: any[], layout: any }[]) {
  const chartFile = outputFile.replace('.json', '.html');
  const html = generateMultiChartHtml(charts);

  fs.writeFileSync(chartFile, html);
  console.log(`📊 Chart generated: ${chartFile}`);

  if (process.env.NODE_ENV !== 'test') {
    try {
      const openModule = await import('open');
      const open = openModule.default || openModule;
      await open(chartFile);
      console.log(`🌐 Chart opened in browser`);
    } catch (error: any) {
      console.log(`⚠️ Could not automatically open chart in browser: ${error.message}`);
      console.log(`📁 Please manually open: ${chartFile}`);
    }
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
  const monthlySummary: Record<string, any> = {};

  for (const r of results) {
    const date = new Date(r.date);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlySummary[monthKey]) {
      monthlySummary[monthKey] = {
        added: { direct: 0, transitive: 0 },
        removed: { direct: 0, transitive: 0 },
        modified: { direct: 0, transitive: 0 },
        totalChanges: 0
      };
    }

    const m = monthlySummary[monthKey];

    m.added.direct += r.added?.direct ?? 0;
    m.added.transitive += r.added?.transitive ?? 0;
    m.removed.direct += r.removed?.direct ?? 0;
    m.removed.transitive += r.removed?.transitive ?? 0;
    m.modified.direct += r.modified?.direct ?? 0;
    m.modified.transitive += r.modified?.transitive ?? 0;

    m.totalChanges += r.totalChanges ?? 0;
  }

  const sortedMonths = Object.keys(monthlySummary).sort();
  const aggregated = sortedMonths.map(month => ({ month, ...monthlySummary[month] }));

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
      x: sortedMonths,
      y: aggregated.map(r => r.added.direct),
      name: 'Direct Added',
      ...commonTraceProps
    };

    const traceTransitiveAdded = {
      x: sortedMonths,
      y: aggregated.map(r => r.added.transitive),
      name: 'Transitive Added',
      ...commonTraceProps
    };

    const traceDirectRemoved = {
      x: sortedMonths,
      y: aggregated.map(r => r.removed.direct),
      name: 'Direct Removed',
      ...commonTraceProps
    };

    const traceTransitiveRemoved = {
      x: sortedMonths,
      y: aggregated.map(r => r.removed.transitive),
      name: 'Transitive Removed',
      ...commonTraceProps
    };

    const traceDirectModified = {
      x: sortedMonths,
      y: aggregated.map(r => r.modified.direct),
      name: 'Direct Modified',
      ...commonTraceProps
    };

    const traceTransitiveModified = {
      x: sortedMonths,
      y: aggregated.map(r => r.modified.transitive),
      name: 'Transitive Modified',
      ...commonTraceProps
    };

    const traceTotalChanges = {
      x: sortedMonths,
      y: (() => {
        const totals: number[] = [];
        let runningTotal = 0;
        for (const r of aggregated) {
          runningTotal += r.totalChanges;
          totals.push(runningTotal);
        }
        return totals;
      })(),
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
      title: `📈 Growth Pattern of Dependencies (${type})`,
      barmode: isStacked ? 'stack' : undefined,
      xaxis: {
        title: 'Month',
        tickangle: -30,
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
        r: 100,
        t: 80,
        b: 100
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

export function generateVulnerabilityFixBySeverityChartData(
  results: Record<string, Record<string, number>>,
  options: MetricOptions
): { data: any[]; layout: any }[] {
  const months = Object.keys(results).sort();

  const formattedMonths = months.map(month => {
    const [year, monthPart] = month.split('-');
    const date = new Date(`${year}-${monthPart}-01`);
    return date.toLocaleString('en-US', { month: 'short', year: 'numeric' }); // e.g., "May 2025"
  });

  const allSeverities = Array.from(new Set(months.flatMap(month => Object.keys(results[month]))));

  const colorMap: Record<string, string> = {
    CRITICAL: '#8B0000',
    HIGH: '#FF8F00',
    MODERATE: '#1565C0',
    LOW: '#2E7D32'
  };

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

    const traces = allSeverities.map(severity => {
      const severityLabel = severity.toUpperCase();
      const color = colorMap[severityLabel] || '#888';

      return {
        x: formattedMonths,
        y: months.map(month => results[month]?.[severity] || 0),
        name: severityLabel,
        ...commonTraceProps,
        ...(traceType === 'bar'
          ? { marker: { color } }
          : { line: { color } })
      };
    });

    const layout = {
      title: `🛡️ Fixed Vulnerabilities by Severity Over Time (${type})`,
      barmode: isStacked ? 'stack' : (traceType === 'bar' ? 'group' : undefined),
      xaxis: {
        title: 'Month',
        tickangle: -45,
        automargin: true
      },
      yaxis: {
        title: 'Fix Count'
      },
      margin: {
        l: 50,
        r: 30,
        t: 60,
        b: 120
      }
    };

    return {
      data: traces,
      layout
    };
  });
}

export function generateVulnerabilityFixTimelinessChartData(
  results: Record<string, Record<string, { fixedInTime: number; fixedLate: number } & { totalVulnerabilities?: number }>>,
  options: MetricOptions
): { data: any[]; layout: any }[] {
  const months = Object.keys(results).sort();

  const formattedMonths = months.map(month => {
    const [year, monthPart] = month.split('-');
    return new Date(`${year}-${monthPart}-01`).toLocaleString('en-US', {
      month: 'short',
      year: 'numeric'
    });
  });

  const allSeverities = Array.from(
    new Set(months.flatMap(m => Object.keys(results[m]).filter(k => k !== 'totalVulnerabilities')))
  );

  const colorMap: Record<string, string> = {
    'CRITICAL - Fixed In Time': '#8B0000',
    'CRITICAL - Fixed Late': '#E57373',
    'HIGH - Fixed In Time': '#FF8F00',
    'HIGH - Fixed Late': '#FFD54F',
    'MODERATE - Fixed In Time': '#1565C0',
    'MODERATE - Fixed Late': '#64B5F6',
    'LOW - Fixed In Time': '#2E7D32',
    'LOW - Fixed Late': '#81C784',
    'Total Vulnerabilities': '#424242'
  };

  return options.chartType.map(type => {
    const traceType = type === 'line' || type === 'stacked-area' ? 'scatter' : 'bar';
    const isStacked = type === 'stacked';
    const isArea = type === 'stacked-area';

    const commonProps = {
      type: traceType,
      mode: traceType === 'scatter' ? 'lines+markers' : undefined,
      fill: isArea ? 'tonexty' : undefined,
      stackgroup: isArea ? 'one' : undefined
    };

    const fixTraces = allSeverities.flatMap(severity => {
      const severityLabel = severity.toUpperCase();
      const fixedInTimeName = `${severityLabel} - Fixed In Time`;
      const fixedLateName = `${severityLabel} - Fixed Late`;

      const fixedInTime = {
        x: formattedMonths,
        y: months.map(m => results[m]?.[severity]?.fixedInTime || 0),
        name: fixedInTimeName,
        ...commonProps,
        ...(traceType === 'bar'
          ? { marker: { color: colorMap[fixedInTimeName] } }
          : { line: { color: colorMap[fixedInTimeName] } })
      };

      const fixedLate = {
        x: formattedMonths,
        y: months.map(m => results[m]?.[severity]?.fixedLate || 0),
        name: fixedLateName,
        ...commonProps,
        ...(traceType === 'bar'
          ? { marker: { color: colorMap[fixedLateName] } }
          : { line: { color: colorMap[fixedLateName] } })
      };

      return [fixedInTime, fixedLate];
    });

    const totalVulnerabilitiesTrace = {
      x: formattedMonths,
      y: months.map(m => results[m]?.totalVulnerabilities || 0),
      name: 'Total Vulnerabilities',
      type: 'scatter',
      mode: 'lines+markers',
      line: {
        dash: 'dot',
        width: 3,
        color: colorMap['Total Vulnerabilities']
      },
      marker: { size: 6 }
    };

    const data = [...fixTraces, totalVulnerabilitiesTrace];

    const layout = {
      title: `⏱️ Timeliness of Vulnerability Fixes per Month according to ISO (${type})`,
      barmode: isStacked ? 'stack' : (traceType === 'bar' ? 'group' : undefined),
      xaxis: {
        title: 'Month',
        tickangle: -45,
        automargin: true
      },
      yaxis: {
        title: 'Count'
      },
      margin: {
        l: 50,
        r: 30,
        t: 60,
        b: 120
      }
    };

    return { data, layout };
  });
}


