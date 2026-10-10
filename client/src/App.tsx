import { useEffect, useState, useSyncExternalStore } from "react";
import type { AppDefaults } from "./types";
import { fetchDefaults } from "./api";
import { useAnalysis } from "./useAnalysis";
import { shownResult } from "./analysisState";
import { AnalysisProgressPanel } from "./components/AnalysisProgressPanel";
import { Header } from "./components/Header";
import { AnalyzeForm } from "./components/AnalyzeForm";
import { SummaryCards } from "./components/SummaryCards";
import { DataSourceNote } from "./components/DataSourceNote";
import { ExcludedBotsNote } from "./components/ExcludedBotsNote";
import { ReviewsChart } from "./components/ReviewsChart";
import { TypesChart } from "./components/TypesChart";
import { ReviewerTable } from "./components/ReviewerTable";
import { FirstResponseSection } from "./components/FirstResponseSection";
import { ReviewCycleSection } from "./components/ReviewCycleSection";
import { RepoSwitcher } from "./components/RepoSwitcher";
import { repoOptionId } from "./components/repoOption";
import { RepoComparison } from "./components/RepoComparison";

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

// True from `dueAt` on; false while dueAt is null.
function useReached(dueAt: number | null): boolean {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (dueAt === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, dueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [dueAt]);
  return dueAt !== null && now >= dueAt;
}

export default function App() {
  const isDark = useDarkMode();
  const {
    shown,
    loading,
    error,
    progress,
    startedAt,
    progressPanelDueAt,
    analyze,
    refresh,
    selectRepo,
  } = useAnalysis();
  // The selected repo's metrics over the query's coverage, so every section below the
  // switcher reads the selected repo from `result`.
  const result = shown ? shownResult(shown) : null;
  const byRepo = shown?.result.byRepo ?? [];
  const hasRepoSwitcher = byRepo.length > 1;
  const showProgress = useReached(progressPanelDueAt);
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
        <AnalyzeForm onSubmit={analyze} loading={loading} defaults={defaults} />

        {showProgress && startedAt !== null && (
          <AnalysisProgressPanel progress={progress} startedAt={startedAt} />
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

        {shown && result && !loading && (
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

            {/* Above the switcher: the listing and the cache are the query's, not a repo's. */}
            {result.dataSource && (
              <DataSourceNote
                dataSource={result.dataSource}
                matchingPRs={result.matchingPRs}
                loading={loading}
                onRefresh={refresh}
              />
            )}

            {hasRepoSwitcher && (
              <RepoSwitcher
                byRepo={byRepo}
                totalPRs={shown.result.countedPRs}
                selected={shown.repo}
                onSelect={selectRepo}
              />
            )}

            <div className="space-y-3">
              <SummaryCards data={result} />
              {result.excludedBots && <ExcludedBotsNote excludedBots={result.excludedBots} />}
            </div>

            {hasRepoSwitcher && shown.repo === null && (
              <RepoComparison
                byRepo={byRepo}
                total={shown.result}
                onSelect={(repo) => {
                  selectRepo(repo);
                  // The table goes away with the selection, so focus moves to the switcher.
                  // It sticks to the top, so it is already in view.
                  document.getElementById(repoOptionId(repo))?.focus({ preventScroll: true });
                }}
              />
            )}

            <FirstResponseSection
              summary={result.firstResponse}
              teamMembers={shown.team}
              includeBots={result.excludedBots === null}
              isDark={isDark}
            />

            <ReviewCycleSection
              summary={result.reviewCycle}
              teamMembers={shown.team}
              includeBots={result.excludedBots === null}
            />

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
