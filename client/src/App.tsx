import { useState, useEffect, useSyncExternalStore } from "react";
import type { AnalysisResult, AnalyzeFormValues, AppDefaults } from "./types";
import { fetchAnalysis, fetchDefaults } from "./api";
import { Header } from "./components/Header";
import { AnalyzeForm } from "./components/AnalyzeForm";
import { SummaryCards } from "./components/SummaryCards";
import { ReviewsChart } from "./components/ReviewsChart";
import { TypesChart } from "./components/TypesChart";
import { ReviewerTable } from "./components/ReviewerTable";

function subscribeToDarkMode(callback: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getIsDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function useDarkMode() {
  return useSyncExternalStore(subscribeToDarkMode, getIsDark);
}

export default function App() {
  const isDark = useDarkMode();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [defaults, setDefaults] = useState<AppDefaults | undefined>(undefined);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    fetchDefaults()
      .then(setDefaults)
      .catch(() => {
        // Silently ignore — form will use its own built-in fallback values.
      });
  }, []);

  const handleAnalyze = async (values: AnalyzeFormValues) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAnalysis(values);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const showTruncatedWarning = result && !result.isComplete;
  const truncatedMessage = result
    ? (() => {
        const { matchingPRs, analyzedPRs } = result;
        const reasons = (result.partialReasons ?? []).filter(
          (r) => typeof r === "string" && r.trim(),
        );
        const reasonText = reasons.length
          ? ` ${reasons.slice(0, 2).join(" ")}`
          : " Narrow your time range or add a label filter for complete results.";
        return `Showing results for ${analyzedPRs.toLocaleString()} of ${matchingPRs.toLocaleString()} matching PRs.${reasonText}`;
      })()
    : "";

  return (
    <div className="bg-slate-50 dark:bg-slate-950 text-gray-900 dark:text-slate-100 min-h-screen font-sans">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Header />
        <AnalyzeForm onSubmit={handleAnalyze} loading={loading} defaults={defaults} />

        {loading && (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="relative">
              <div className="w-12 h-12 rounded-full border-4 border-gray-200 dark:border-slate-700" />
              <div className="w-12 h-12 rounded-full border-4 border-indigo-600 border-t-transparent animate-spin absolute top-0 left-0" />
            </div>
            <p className="mt-4 text-gray-500 dark:text-slate-400 text-sm">
              Fetching and analyzing PR data...
            </p>
            <p className="mt-1 text-gray-400 dark:text-slate-500 text-xs">
              This may take a moment for large repositories
            </p>
          </div>
        )}

        {error && (
          <div className="mb-8">
            <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-red-500 mt-0.5 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p className="text-red-800 dark:text-red-300 text-sm">{error}</p>
              </div>
            </div>
          </div>
        )}

        {result && !loading && (
          <div className="space-y-8">
            {showTruncatedWarning && (
              <div className="bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-amber-500 mt-0.5 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <p className="text-amber-800 dark:text-amber-300 text-sm">{truncatedMessage}</p>
                </div>
              </div>
            )}

            <SummaryCards data={result} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800 p-6">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100 mb-4">
                  Reviews by Reviewer
                </h3>
                <ReviewsChart stats={result.reviewerStats} isDark={isDark} />
              </div>
              <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800 p-6">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100 mb-4">
                  Review Type Distribution
                </h3>
                <TypesChart stats={result.reviewerStats} isDark={isDark} />
              </div>
            </div>

            <ReviewerTable stats={result.reviewerStats} />
          </div>
        )}
      </div>
    </div>
  );
}
