import { useMemo } from "react";
import { Bar } from "react-chartjs-2";
import type { ReviewerStats } from "../types";

const COLORS = {
  approved: "#10b981",
  changes: "#f59e0b",
  comments: "#0ea5e9",
};

interface ReviewsChartProps {
  stats: ReviewerStats[];
  isDark: boolean;
}

export function ReviewsChart({ stats, isDark }: ReviewsChartProps) {
  const sorted = useMemo(() => [...stats].sort((a, b) => b.totalReviews - a.totalReviews), [stats]);

  const data = useMemo(
    () => ({
      labels: sorted.map((s) => s.login),
      datasets: [
        {
          label: "Approved",
          data: sorted.map((s) => s.approvals),
          backgroundColor: COLORS.approved,
        },
        {
          label: "Changes Requested",
          data: sorted.map((s) => s.changesRequested),
          backgroundColor: COLORS.changes,
        },
        {
          label: "Comments",
          data: sorted.map((s) => s.comments),
          backgroundColor: COLORS.comments,
        },
      ],
    }),
    [sorted],
  );

  const textColor = isDark ? "#94a3b8" : undefined;
  const gridColor = isDark ? "#1e293b" : "#f1f5f9";

  const options = useMemo(
    () => ({
      indexAxis: "y" as const,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          grid: { color: gridColor },
          ticks: { font: { size: 11 }, color: textColor },
        },
        y: {
          stacked: true,
          grid: { display: false },
          ticks: { font: { size: 12 }, color: textColor },
        },
      },
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
            afterTitle: (items: { dataIndex: number }[]) => {
              const idx = items[0].dataIndex;
              return `Total: ${sorted[idx].totalReviews}`;
            },
          },
        },
      },
    }),
    [isDark, sorted, textColor, gridColor],
  );

  const height = Math.max(300, sorted.length * 40);

  return (
    <div style={{ height }}>
      <Bar data={data} options={options} />
    </div>
  );
}
