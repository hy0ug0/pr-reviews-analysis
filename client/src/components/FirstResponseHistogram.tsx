import { useMemo } from "react";
import { Bar } from "react-chartjs-2";
import type { ChartOptions, Plugin, TooltipItem } from "chart.js";
import { pluralize } from "../../../shared/format";
import type { DurationBucket } from "../types";
import { chartTheme } from "./chartTheme";

interface FirstResponseHistogramProps {
  buckets: DurationBucket[];
  isDark: boolean;
}

// Writes each non-empty bar's count above it, so the counts read without hovering.
function barCountLabels(color: string): Plugin<"bar"> {
  return {
    id: "barCountLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const values = chart.data.datasets[0]?.data ?? [];
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = `600 12px ${chart.options.font?.family ?? "sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      chart.getDatasetMeta(0).data.forEach((bar, index) => {
        const value = values[index];
        if (typeof value !== "number" || value === 0) return;
        ctx.fillText(value.toLocaleString(), bar.x, bar.y - 4);
      });
      ctx.restore();
    },
  };
}

export function FirstResponseHistogram({ buckets, isDark }: FirstResponseHistogramProps) {
  const theme = chartTheme(isDark);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  const data = useMemo(
    () => ({
      labels: buckets.map((bucket) => bucket.label),
      datasets: [
        {
          label: "Responded PRs",
          data: buckets.map((bucket) => bucket.count),
          backgroundColor: theme.series,
          hoverBackgroundColor: theme.series,
          borderRadius: 4,
          borderSkipped: "start" as const,
          maxBarThickness: 40,
        },
      ],
    }),
    [buckets, theme.series],
  );

  const options = useMemo(
    (): ChartOptions<"bar"> => ({
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          border: { color: theme.grid },
          ticks: { font: { size: 12 }, color: theme.text },
          title: {
            display: true,
            text: "Time to first response",
            font: { size: 11 },
            color: theme.text,
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: { font: { size: 11 }, color: theme.text, precision: 0, maxTicksLimit: 6 },
          title: { display: true, text: "PRs", font: { size: 11 }, color: theme.text },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: theme.tooltip,
          padding: 10,
          cornerRadius: 8,
          titleFont: { size: 12, weight: 600 },
          bodyFont: { size: 12 },
          callbacks: {
            title: (items: TooltipItem<"bar">[]) => `Answered in ${items[0]?.label ?? ""}`,
            label: (item: TooltipItem<"bar">) => {
              const count = Number(item.raw);
              const share = total > 0 ? Math.round((count / total) * 100) : 0;
              return `${pluralize(count, "PR")} (${share}% of responded)`;
            },
          },
        },
      },
    }),
    [theme.grid, theme.text, theme.tooltip, total],
  );

  const plugins = useMemo(() => [barCountLabels(theme.text)], [theme.text]);

  return (
    <div className="h-64">
      <Bar
        // The count-label plugin is read once at creation, so a theme change remounts.
        key={isDark ? "dark" : "light"}
        data={data}
        options={options}
        plugins={plugins}
        role="img"
        aria-label={`Histogram of time to first response: ${buckets
          .map((bucket) => `${bucket.label}: ${pluralize(bucket.count, "PR")}`)
          .join(", ")}.`}
      />
    </div>
  );
}
