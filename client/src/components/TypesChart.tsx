import { useMemo } from "react";
import { Doughnut } from "react-chartjs-2";
import type { TooltipItem } from "chart.js";
import type { ReviewerStats } from "../types";

const COLORS = {
  approved: "#10b981",
  changes: "#f59e0b",
  comments: "#0ea5e9",
};

interface TypesChartProps {
  stats: ReviewerStats[];
  isDark: boolean;
}

export function TypesChart({ stats, isDark }: TypesChartProps) {
  const totals = useMemo(
    () => ({
      approved: stats.reduce((s, r) => s + r.approvals, 0),
      changes: stats.reduce((s, r) => s + r.changesRequested, 0),
      comments: stats.reduce((s, r) => s + r.comments, 0),
    }),
    [stats],
  );

  const data = useMemo(
    () => ({
      labels: ["Approved", "Changes Requested", "Comments"],
      datasets: [
        {
          data: [totals.approved, totals.changes, totals.comments],
          backgroundColor: [COLORS.approved, COLORS.changes, COLORS.comments],
          borderWidth: 0,
          hoverOffset: 4,
        },
      ],
    }),
    [totals],
  );

  const textColor = isDark ? "#94a3b8" : undefined;

  const options = useMemo(
    () => ({
      responsive: true,
      plugins: {
        legend: {
          position: "bottom" as const,
          labels: {
            boxWidth: 12,
            padding: 16,
            font: { size: 11 },
            color: textColor,
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx: TooltipItem<"doughnut">) => {
              const total = ctx.dataset.data.reduce((sum, value) => sum + Number(value), 0);
              const raw = Number(ctx.raw);
              const safeRaw = Number.isFinite(raw) ? raw : 0;
              const pct = total > 0 ? ((safeRaw / total) * 100).toFixed(1) : "0";
              return ` ${ctx.label}: ${safeRaw} (${pct}%)`;
            },
          },
        },
      },
    }),
    [textColor],
  );

  return <Doughnut data={data} options={options} />;
}
