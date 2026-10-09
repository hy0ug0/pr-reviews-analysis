import { formatDuration, pluralize } from "../../../shared/format";
import { COMMENTS_PAGE_SIZE } from "../../../shared/types";
import type { FirstResponseSummary } from "../types";
import { FirstResponseHistogram } from "./FirstResponseHistogram";
import { FirstResponseTrend } from "./FirstResponseTrend";

interface FirstResponseSectionProps {
  summary: FirstResponseSummary;
  teamMembers: string[];
  // Whether the result counted bots, which changes who can respond.
  includeBots: boolean;
  isDark: boolean;
}

const cardClass =
  "bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800";
const labelClass = "text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wider";

interface CoverageSegment {
  key: string;
  label: string;
  count: number;
  // Fill for the proportion bar.
  fill: string;
  // Legend swatch; the near-surface fills get a ring so they stay visible.
  swatch: string;
}

function coverageSegments(summary: FirstResponseSummary): CoverageSegment[] {
  const segments: CoverageSegment[] = [
    {
      key: "responded",
      label: "responded",
      count: summary.respondedPRs,
      fill: "bg-indigo-600 dark:bg-indigo-500",
      swatch: "bg-indigo-600 dark:bg-indigo-500",
    },
    {
      key: "waiting",
      label: "still waiting",
      count: summary.waitingPRs,
      fill: "bg-slate-400 dark:bg-slate-500",
      swatch: "bg-slate-400 dark:bg-slate-500",
    },
    {
      key: "closed",
      label: "closed without response",
      count: summary.closedWithoutResponsePRs,
      fill: "bg-slate-300 dark:bg-slate-600",
      swatch: "bg-slate-300 dark:bg-slate-600",
    },
    {
      key: "drafts",
      label: summary.draftPRs === 1 ? "draft left out" : "drafts left out",
      count: summary.draftPRs,
      fill: "bg-slate-200 dark:bg-slate-700",
      swatch: "bg-slate-200 dark:bg-slate-700",
    },
    {
      key: "undetermined",
      label: "undetermined",
      count: summary.undeterminedPRs,
      fill: "bg-slate-100 dark:bg-slate-800",
      swatch: "bg-slate-100 ring-1 ring-inset ring-slate-300 dark:bg-slate-800 dark:ring-slate-600",
    },
  ];
  return segments.filter((segment) => segment.key !== "undetermined" || segment.count > 0);
}

function Coverage({
  summary,
  includeBots,
}: {
  summary: FirstResponseSummary;
  includeBots: boolean;
}) {
  const segments = coverageSegments(summary);
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return null;

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-slate-300">
        {summary.respondedPRs > 0 ? (
          <>
            Percentiles cover the{" "}
            <span className="font-semibold text-gray-900 dark:text-slate-100">
              {pluralize(summary.respondedPRs, "PR")}
            </span>{" "}
            that got a response, out of {total.toLocaleString()} opened in this range.
          </>
        ) : (
          `The ${pluralize(total, "PR")} opened in this range:`
        )}
      </p>
      <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <div
              key={segment.key}
              className={`min-w-1 ${segment.fill}`}
              style={{ flexGrow: segment.count, flexBasis: 0 }}
            />
          ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {segments.map((segment) => (
          <li key={segment.key} className="inline-flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${segment.swatch}`} />
            <span className="font-semibold tabular-nums text-gray-900 dark:text-slate-100">
              {segment.count.toLocaleString()}
            </span>
            <span className="text-gray-500 dark:text-slate-400">{segment.label}</span>
          </li>
        ))}
      </ul>
      {summary.undeterminedPRs > 0 && (
        <p className="mt-3 text-xs text-gray-500 dark:text-slate-400">
          Undetermined: the first {COMMENTS_PAGE_SIZE} comments are all from{" "}
          {includeBots ? "the author" : "bots or the author"}, and no review came earlier. The first
          response may be in a later comment, which isn't fetched.
        </p>
      )}
    </div>
  );
}

function Percentiles({ summary }: { summary: FirstResponseSummary }) {
  const secondary = [
    { label: "p75", value: summary.p75Ms },
    { label: "p90", value: summary.p90Ms },
  ];

  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:flex sm:items-end sm:gap-x-10">
      <div className="col-span-2">
        <p className={labelClass}>Median (p50)</p>
        <p className="mt-1 text-4xl sm:text-5xl font-bold text-gray-900 dark:text-slate-100">
          {summary.p50Ms === null ? "–" : formatDuration(summary.p50Ms)}
        </p>
      </div>
      {secondary.map(({ label, value }) => (
        <div key={label}>
          <p className={labelClass}>{label}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-700 dark:text-slate-300">
            {value === null ? "–" : formatDuration(value)}
          </p>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  summary,
  hasTeamFilter,
}: {
  summary: FirstResponseSummary;
  hasTeamFilter: boolean;
}) {
  const total =
    summary.waitingPRs +
    summary.closedWithoutResponsePRs +
    summary.draftPRs +
    summary.undeterminedPRs;

  return (
    <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 px-4 py-6 text-center">
      <p className="text-sm font-medium text-gray-900 dark:text-slate-100">
        {total === 0
          ? "No pull requests were opened in this range."
          : "No PR opened in this range has had a first response yet."}
      </p>
      <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
        {hasTeamFilter
          ? "Only team members' responses count. Clear the team filter or pick a longer range to see more."
          : "Pick a longer time range to see more."}
      </p>
    </div>
  );
}

export function FirstResponseSection({
  summary,
  teamMembers,
  includeBots,
  isDark,
}: FirstResponseSectionProps) {
  const hasTeamFilter = teamMembers.length > 0;
  const hasResponses = summary.respondedPRs > 0;
  const hasGaps = summary.weekly.some((week) => week.p50Ms === null);

  return (
    <section aria-labelledby="first-response-heading" className="space-y-6">
      <div className={`${cardClass} p-6`}>
        <h3
          id="first-response-heading"
          className="text-sm font-semibold text-gray-900 dark:text-slate-100"
        >
          Time to first response
        </h3>
        <p className="mt-1 max-w-3xl text-sm text-gray-500 dark:text-slate-400">
          From ready for review to the first review or comment by someone other than the author.{" "}
          {includeBots
            ? "PRs still in draft are left out."
            : "Bots don't count, and PRs still in draft are left out."}
        </p>
        {hasTeamFilter && (
          <p className="mt-3 inline-flex rounded-lg bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
            Team filter on: only responses from the{" "}
            {teamMembers.length === 1
              ? "listed team member"
              : `${teamMembers.length} listed team members`}{" "}
            count.
          </p>
        )}

        <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[auto_1fr] lg:gap-10">
          {hasResponses ? (
            <Percentiles summary={summary} />
          ) : (
            <div className="lg:col-span-2">
              <EmptyState summary={summary} hasTeamFilter={hasTeamFilter} />
            </div>
          )}
          <div
            className={
              hasResponses
                ? "border-t border-gray-200 pt-6 dark:border-slate-800 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10"
                : "lg:col-span-2"
            }
          >
            <Coverage summary={summary} includeBots={includeBots} />
          </div>
        </div>
      </div>

      {hasResponses && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className={`${cardClass} p-6`}>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">
              How long PRs waited
            </h3>
            <p className="mt-1 mb-4 text-xs text-gray-500 dark:text-slate-400">
              Responded PRs by time to first response
            </p>
            <FirstResponseHistogram buckets={summary.histogram} isDark={isDark} />
          </div>
          <div className={`${cardClass} p-6`}>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">
              Weekly median
            </h3>
            <p className="mt-1 mb-4 text-xs text-gray-500 dark:text-slate-400">
              By the week each PR became ready for review.
              {hasGaps && " Gaps are weeks without a response."}
            </p>
            <FirstResponseTrend weeks={summary.weekly} isDark={isDark} />
          </div>
        </div>
      )}
    </section>
  );
}
