import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import type { ChartOptions, TooltipItem } from "chart.js";
import { formatDuration, formatLongDate, formatShortDate, pluralize } from "../../../shared/format";
import type { WeeklyFirstResponse } from "../types";
import { chartTheme } from "./chartTheme";

interface FirstResponseTrendProps {
  weeks: WeeklyFirstResponse[];
  isDark: boolean;
}

interface AxisUnit {
  ms: number;
  suffix: string;
  name: string;
}

const MINUTES: AxisUnit = { ms: 60 * 1000, suffix: "m", name: "minutes" };
const HOURS: AxisUnit = { ms: 60 * 60 * 1000, suffix: "h", name: "hours" };
const DAYS: AxisUnit = { ms: 24 * 60 * 60 * 1000, suffix: "d", name: "days" };

// Plots in whole units so the axis gets round ticks (0h, 6h, 12h) instead of
// fractions of a millisecond count.
function axisUnit(maxMs: number): AxisUnit {
  if (maxMs < 2 * HOURS.ms) return MINUTES;
  if (maxMs < 2 * DAYS.ms) return HOURS;
  return DAYS;
}

export function FirstResponseTrend({ weeks, isDark }: FirstResponseTrendProps) {
  const theme = chartTheme(isDark);
  const unit = axisUnit(Math.max(0, ...weeks.map((week) => week.p50Ms ?? 0)));

  const data = useMemo(
    () => ({
      labels: weeks.map((week) => formatShortDate(week.weekStart)),
      datasets: [
        {
          label: "Median time to first response",
          // null leaves a gap for weeks without responses.
          data: weeks.map((week) => (week.p50Ms === null ? null : week.p50Ms / unit.ms)),
          borderColor: theme.series,
          backgroundColor: theme.series,
          borderWidth: 2,
          borderJoinStyle: "round" as const,
          borderCapStyle: "round" as const,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBorderColor: theme.surface,
          pointBorderWidth: 2,
          pointHoverBackgroundColor: theme.series,
          pointHoverBorderColor: theme.surface,
          pointHoverBorderWidth: 2,
          pointHitRadius: 12,
          spanGaps: false,
          tension: 0,
        },
      ],
    }),
    [weeks, unit.ms, theme.series, theme.surface],
  );

  const options = useMemo(
    (): ChartOptions<"line"> => ({
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 8, right: 8 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          border: { color: theme.grid },
          ticks: { font: { size: 11 }, color: theme.text, maxRotation: 0, autoSkipPadding: 12 },
          title: {
            display: true,
            text: "Week starting (UTC)",
            font: { size: 11 },
            color: theme.text,
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: {
            font: { size: 11 },
            color: theme.text,
            maxTicksLimit: 6,
            callback: (value) => `${Number(value).toLocaleString()}${unit.suffix}`,
          },
          title: {
            display: true,
            text: `Median, in ${unit.name}`,
            font: { size: 11 },
            color: theme.text,
          },
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
            title: (items: TooltipItem<"line">[]) => {
              const week = weeks[items[0]?.dataIndex ?? -1];
              return week ? `Week of ${formatLongDate(week.weekStart)}` : "";
            },
            label: (item: TooltipItem<"line">) => {
              const week = weeks[item.dataIndex];
              return week?.p50Ms == null ? "" : `Median ${formatDuration(week.p50Ms)}`;
            },
            afterLabel: (item: TooltipItem<"line">) => {
              const week = weeks[item.dataIndex];
              return week ? `${pluralize(week.count, "PR")} responded` : "";
            },
          },
        },
      },
    }),
    [weeks, unit, theme.grid, theme.text, theme.tooltip],
  );

  const described = weeks
    .filter((week) => week.p50Ms !== null)
    .map((week) => `week of ${formatShortDate(week.weekStart)}: ${formatDuration(week.p50Ms ?? 0)}`)
    .join(", ");

  return (
    <div className="h-64">
      <Line
        data={data}
        options={options}
        role="img"
        aria-label={`Weekly median time to first response: ${described}.`}
      />
    </div>
  );
}
