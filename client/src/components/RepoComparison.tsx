import type { ReactNode } from "react";
import { formatDuration, pluralize } from "../../../shared/format";
import type { AnalysisMetrics, RepoMetrics } from "../types";
import { RepoName } from "./RepoSwitcher";
import { TooltipIcon } from "./ReviewerTable";
import { MIN_SAMPLES_FOR_P90 } from "./sampleSize";

interface RepoComparisonProps {
  byRepo: RepoMetrics[];
  // The whole result's metrics, for the total row.
  total: AnalysisMetrics;
  onSelect: (repo: string) => void;
}

const dash = <span className="text-gray-400 dark:text-slate-500">–</span>;

// A median with its sample count, as in the reviewer table.
function Median({ ms, samples, noun }: { ms: number | null; samples: number; noun: string }) {
  if (ms === null) return dash;
  return (
    <span title={`Over ${pluralize(samples, noun)}`}>
      <span className="mr-2 text-xs text-gray-500 dark:text-slate-400">n={samples}</span>
      {formatDuration(ms)}
    </span>
  );
}

function P90({ ms, samples, noun }: { ms: number | null; samples: number; noun: string }) {
  if (ms === null) return dash;
  const isNoisy = samples < MIN_SAMPLES_FOR_P90;
  return (
    <span
      className={isNoisy ? "text-gray-500 dark:text-slate-400" : undefined}
      title={isNoisy ? `Only ${pluralize(samples, noun)}: too few for a stable p90` : undefined}
    >
      {formatDuration(ms)}
    </span>
  );
}

// The PR count with a bar against the busiest repo, so the volume behind every other number
// reads at a glance. The total row has no bar.
function PRCount({ count, max }: { count: number; max: number | null }) {
  return (
    <span className="inline-flex items-center justify-end gap-3">
      {max !== null && (
        <span
          className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-100 sm:block dark:bg-slate-800"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full bg-indigo-600 dark:bg-indigo-500"
            style={{ width: max > 0 ? `${(count / max) * 100}%` : 0 }}
          />
        </span>
      )}
      {count.toLocaleString()}
    </span>
  );
}

interface Column {
  label: string;
  tooltip?: string;
  // `maxPRs` is null on the total row.
  cell: (metrics: AnalysisMetrics, maxPRs: number | null) => ReactNode;
  className?: string;
}

// One entry per number to compare. A metric added to AnalysisMetrics already shows per repo
// in every section below the switcher; a column here only lines it up across repos.
const columns: Column[] = [
  {
    label: "PRs",
    tooltip: "PRs the metrics count, as on the Total PRs card.",
    cell: (m, maxPRs) => <PRCount count={m.countedPRs} max={maxPRs} />,
    className: "font-semibold text-gray-900 dark:text-slate-100",
  },
  {
    label: "Reviews",
    cell: (m) => m.totalReviews.toLocaleString(),
  },
  {
    label: "Reviewers",
    tooltip:
      "People with a counted review in the repository. Someone who reviews in several repositories counts once in the total, so the rows can add up to more.",
    cell: (m) => m.uniqueReviewers.toLocaleString(),
  },
  {
    label: "Reviews / PR",
    cell: (m) => (m.countedPRs > 0 ? m.avgReviewsPerPR.toFixed(1) : dash),
  },
  {
    label: "First response p50",
    tooltip:
      "Median time from ready for review to the first review or comment by someone other than the author. n is the number of PRs that got a response.",
    cell: (m) => (
      <Median
        ms={m.firstResponse.p50Ms}
        samples={m.firstResponse.respondedPRs}
        noun="responded PR"
      />
    ),
    className: "text-gray-900 dark:text-slate-100",
  },
  {
    label: "p90",
    tooltip: `90th percentile time to first response. Dimmed with fewer than ${MIN_SAMPLES_FOR_P90} responded PRs, where it is mostly the slowest one.`,
    cell: (m) => (
      <P90 ms={m.firstResponse.p90Ms} samples={m.firstResponse.respondedPRs} noun="responded PR" />
    ),
    className: "text-gray-900 dark:text-slate-100",
  },
  {
    label: "Time to merge p50",
    tooltip:
      "Median time from ready for review to merge, over the merged PRs. n is the number of merged PRs.",
    cell: (m) => (
      <Median
        ms={m.reviewCycle.timeToMerge.p50Ms}
        samples={m.reviewCycle.timeToMerge.mergedPRs}
        noun="merged PR"
      />
    ),
    className: "text-gray-900 dark:text-slate-100",
  },
];

// Why a repository counts no PR: none matched, or bots opened all of them.
function emptyRepoNote({ excludedBots }: AnalysisMetrics): string {
  return excludedBots && excludedBots.prs > 0
    ? `Only ${pluralize(excludedBots.prs, "bot PR")}, not counted`
    : "No PRs in this range";
}

const cellClass = "px-4 py-3 last:pr-6 whitespace-nowrap text-right text-sm tabular-nums";
// The repository column stays put while the numbers scroll on a narrow screen, so its cells
// need opaque fills: these match slate-800/50 over the slate-900 card.
const stickyCellClass = "sticky left-0 z-[1] py-3 pr-4 pl-6 text-left";
const stickyHeaderFill =
  "bg-gray-50 dark:bg-[color-mix(in_oklab,var(--color-slate-800)_50%,var(--color-slate-900))]";
const stickyRowFill =
  "bg-white group-hover:bg-gray-50 dark:bg-slate-900 dark:group-hover:bg-[color-mix(in_oklab,var(--color-slate-800)_50%,var(--color-slate-900))]";

// The repositories side by side, in the switcher's order, over a total row with the whole
// result. Only shown for more than one repository.
export function RepoComparison({ byRepo, total, onSelect }: RepoComparisonProps) {
  const maxPRs = Math.max(...byRepo.map(({ metrics }) => metrics.countedPRs));

  return (
    <section
      aria-labelledby="repo-comparison-heading"
      className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="border-b border-gray-200 px-6 py-4 dark:border-slate-800">
        <h3
          id="repo-comparison-heading"
          className="text-sm font-semibold text-gray-900 dark:text-slate-100"
        >
          By repository
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
          Pick a repository to see its own charts and reviewers.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800">
          <thead className="bg-gray-50 dark:bg-slate-800/50">
            <tr>
              <th
                scope="col"
                className={`${stickyCellClass} ${stickyHeaderFill} text-xs font-medium tracking-wider text-gray-500 uppercase dark:text-slate-400`}
              >
                Repository
              </th>
              {columns.map((col) => (
                <th
                  key={col.label}
                  scope="col"
                  aria-label={col.label}
                  className="px-4 py-3 last:pr-6 text-right text-xs font-medium tracking-wider whitespace-nowrap text-gray-500 uppercase dark:text-slate-400"
                >
                  <span className="inline-flex w-full items-center justify-end gap-1">
                    {col.label}
                    {col.tooltip && <TooltipIcon text={col.tooltip} label={col.label} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-slate-800">
            {byRepo.map(({ repo, metrics }) => (
              <tr key={repo} className="group">
                <th scope="row" className={`${stickyCellClass} ${stickyRowFill} font-normal`}>
                  <button
                    type="button"
                    onClick={() => onSelect(repo)}
                    title={`Show ${repo}`}
                    className="block max-w-[9rem] truncate rounded-sm text-left text-sm font-medium text-gray-900 hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none sm:max-w-[14rem] dark:text-slate-100 dark:hover:text-indigo-400 dark:focus-visible:ring-indigo-400"
                  >
                    <RepoName repo={repo} />
                  </button>
                  {metrics.countedPRs === 0 && (
                    <span className="block text-xs text-gray-500 dark:text-slate-400">
                      {emptyRepoNote(metrics)}
                    </span>
                  )}
                </th>
                {columns.map((col) => (
                  <td
                    key={col.label}
                    className={`${cellClass} group-hover:bg-gray-50 dark:group-hover:bg-slate-800/50 ${col.className ?? "text-gray-600 dark:text-slate-300"}`}
                  >
                    {col.cell(metrics, maxPRs)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-gray-200 bg-gray-50 dark:border-slate-800 dark:bg-slate-800/50">
            <tr>
              <th
                scope="row"
                className={`${stickyCellClass} ${stickyHeaderFill} text-sm font-semibold text-gray-900 dark:text-slate-100`}
              >
                All repositories
              </th>
              {columns.map((col) => (
                <td
                  key={col.label}
                  className={`${cellClass} font-semibold ${col.className ?? "text-gray-900 dark:text-slate-100"}`}
                >
                  {col.cell(total, null)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
