import type { AnalysisResult } from "../types";

interface SummaryCardsProps {
  data: AnalysisResult;
}

type SummaryMetricKey = "matchingPRs" | "totalReviews" | "uniqueReviewers" | "avgReviewsPerPR";

const cards: { label: string; key: SummaryMetricKey; decimals?: number }[] = [
  { label: "Total PRs", key: "matchingPRs" },
  { label: "Total Reviews", key: "totalReviews" },
  { label: "Unique Reviewers", key: "uniqueReviewers" },
  { label: "Avg Reviews / PR", key: "avgReviewsPerPR", decimals: 1 },
];

export function SummaryCards({ data }: SummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(({ label, key, decimals }) => {
        const value = data[key];
        const display = decimals !== undefined ? value.toFixed(decimals) : value.toLocaleString();

        return (
          <div
            key={key}
            className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800 p-5"
          >
            <p className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wider">
              {label}
            </p>
            <p className="text-3xl font-bold text-gray-900 dark:text-slate-100 mt-1">{display}</p>
          </div>
        );
      })}
    </div>
  );
}
