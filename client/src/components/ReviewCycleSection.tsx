import type { ReactNode } from "react";
import { formatDuration, pluralize } from "../../../shared/format";
import type { ReviewCycleSummary } from "../types";
import { DistributionBars, type DistributionRow } from "./DistributionBars";
import { MIN_SAMPLES_FOR_P90 } from "./sampleSize";

interface ReviewCycleSectionProps {
  summary: ReviewCycleSummary;
  teamMembers: string[];
  // Whether the result counted bots, which changes whose reviews count.
  includeBots: boolean;
}

type MergeSummary = ReviewCycleSummary["timeToMerge"];
type ApprovalSummary = ReviewCycleSummary["timeToApproval"];
type RoundsSummary = ReviewCycleSummary["reviewRounds"];

const cardClass =
  "bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800";
const labelClass = "text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wider";
const noteClass = "text-xs text-gray-500 dark:text-slate-400";

function Percentiles({
  median,
  p90,
  samples,
}: {
  median: ReactNode;
  p90: ReactNode;
  samples: number;
}) {
  const isNoisy = samples < MIN_SAMPLES_FOR_P90;
  return (
    <div>
      <div className="flex items-end gap-x-8">
        <div>
          <p className={labelClass}>Median (p50)</p>
          <p className="mt-1 text-4xl font-bold tabular-nums text-gray-900 dark:text-slate-100">
            {median}
          </p>
        </div>
        <div>
          <p className={labelClass}>p90</p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${
              isNoisy ? "text-gray-500 dark:text-slate-400" : "text-gray-700 dark:text-slate-300"
            }`}
          >
            {p90}
          </p>
        </div>
      </div>
      {isNoisy && (
        <p className={`mt-2 ${noteClass}`}>
          Only {pluralize(samples, "PR")}, so the p90 is close to the slowest one.
        </p>
      )}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 px-4 py-6 text-center">
      <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{title}</p>
      <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{hint}</p>
    </div>
  );
}

function emptyHint(teamMembers: string[]): string {
  return teamMembers.length > 0
    ? "Only team members' reviews count. Clear the team filter or pick a longer range to see more."
    : "Pick a longer time range to see more.";
}

// The notes sit at the bottom, so the figures of side-by-side cards start at the same height.
function MetricCard({
  id,
  title,
  description,
  notes,
  children,
}: {
  id: string;
  title: string;
  description: string;
  notes: ReactNode;
  children: ReactNode;
}) {
  return (
    <article aria-labelledby={id} className={`${cardClass} flex flex-col p-6`}>
      <h3 id={id} className="text-sm font-semibold text-gray-900 dark:text-slate-100">
        {title}
      </h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{description}</p>
      <div className="mt-5 flex flex-col gap-5">{children}</div>
      <div className="mt-auto space-y-2 pt-5">{notes}</div>
    </article>
  );
}

function Sample({ children }: { children: ReactNode }) {
  return <p className="text-sm text-gray-600 dark:text-slate-300">{children}</p>;
}

function Strong({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-gray-900 dark:text-slate-100">{children}</span>;
}

// Counts left out of a metric, as "12 still open, 3 drafts"; empty ones are dropped.
function LeftOut({ items }: { items: Array<{ count: number; label: string }> }) {
  const shown = items.filter((item) => item.count > 0);
  if (shown.length === 0) return null;
  return (
    <p className={noteClass}>
      Not counted:{" "}
      {shown.map((item, index) => (
        <span key={item.label}>
          {index > 0 && ", "}
          <span className="font-medium tabular-nums text-gray-700 dark:text-slate-300">
            {item.count.toLocaleString()}
          </span>{" "}
          {item.label}
        </span>
      ))}
      .
    </p>
  );
}

// Whose reviews count, for the two metrics built on reviews.
function ReviewerRules({
  teamMembers,
  includeBots,
}: {
  teamMembers: string[];
  includeBots: boolean;
}) {
  return (
    <>
      <p className={noteClass}>
        {includeBots
          ? "The author's reviews don't count."
          : "Reviews by bots or the author don't count."}
      </p>
      {teamMembers.length > 0 && (
        <p className="text-xs text-indigo-700 dark:text-indigo-300">
          Team filter on: only reviews by the{" "}
          {teamMembers.length === 1
            ? "listed team member"
            : `${teamMembers.length} listed team members`}{" "}
          count.
        </p>
      )}
    </>
  );
}

// An exact 0 is an approval at the first review; formatDuration would show "< 1m".
function formatMs(value: number | null): string {
  if (value === null) return "–";
  return value === 0 ? "0m" : formatDuration(value);
}

function durationRows(histogram: MergeSummary["histogram"]): DistributionRow[] {
  return histogram.map((bucket) => ({ label: bucket.label, count: bucket.count }));
}

// The first bucket also holds the PRs approved at their first review. They get a row of their
// own, so an approval with no second look doesn't pass for a quick one.
function approvalRows(summary: ApprovalSummary): DistributionRow[] {
  const [first, ...rest] = durationRows(summary.histogram);
  if (!first) return [];
  const zeros = summary.approvedAtFirstReviewPRs;
  return [{ label: "0", count: zeros }, { ...first, count: first.count - zeros }, ...rest];
}

function Rounds({ value }: { value: number | null }) {
  if (value === null) return "–";
  return (
    <>
      {value.toLocaleString("en-US", { maximumFractionDigits: 1 })}
      <span className="ml-1.5 text-sm font-medium text-gray-500 dark:text-slate-400">
        {value === 1 ? "round" : "rounds"}
      </span>
    </>
  );
}

function TimeToMergeCard({ summary }: { summary: MergeSummary }) {
  const opened = summary.mergedPRs + summary.openPRs + summary.closedUnmergedPRs;
  return (
    <MetricCard
      id="time-to-merge-heading"
      title="Time to merge"
      description="From ready for review to merge. Merged PRs count whether reviewed or not."
      notes={
        <LeftOut
          items={[
            { count: summary.openPRs, label: "still open" },
            { count: summary.closedUnmergedPRs, label: "closed without merging" },
          ]}
        />
      }
    >
      {summary.mergedPRs === 0 ? (
        <EmptyState
          title={
            opened === 0
              ? "No pull requests were opened in this range."
              : "No PR opened in this range has been merged yet."
          }
          hint="Pick a longer time range to see more."
        />
      ) : (
        <>
          <Percentiles
            median={formatMs(summary.p50Ms)}
            p90={formatMs(summary.p90Ms)}
            samples={summary.mergedPRs}
          />
          <Sample>
            Covers the <Strong>{pluralize(summary.mergedPRs, "merged PR")}</Strong>, out of{" "}
            {opened.toLocaleString()} opened in this range.
          </Sample>
          <DistributionBars
            rows={durationRows(summary.histogram)}
            of="merged PRs"
            name="Time to merge"
          />
        </>
      )}
    </MetricCard>
  );
}

function TimeToApprovalCard({
  summary,
  teamMembers,
  includeBots,
}: {
  summary: ApprovalSummary;
  teamMembers: string[];
  includeBots: boolean;
}) {
  const reviewed = summary.approvedPRs + summary.notApprovedPRs;
  const atFirstReview = summary.approvedAtFirstReviewPRs;
  return (
    <MetricCard
      id="time-to-approval-heading"
      title="Time to approval"
      description="From the first review to the first approval that wasn't dismissed."
      notes={
        <>
          <LeftOut
            items={[
              { count: summary.notApprovedPRs, label: "reviewed, not approved" },
              { count: summary.unreviewedPRs, label: "not reviewed" },
              { count: summary.draftPRs, label: summary.draftPRs === 1 ? "draft" : "drafts" },
              { count: summary.undeterminedPRs, label: "with reviews that couldn't be fetched" },
            ]}
          />
          <ReviewerRules teamMembers={teamMembers} includeBots={includeBots} />
        </>
      }
    >
      {summary.approvedPRs === 0 ? (
        <EmptyState
          title={
            // An undetermined PR may have been reviewed or approved in the unfetched reviews.
            summary.undeterminedPRs > 0
              ? "No approval in this range could be timed."
              : reviewed === 0
                ? "No PR opened in this range has been reviewed yet."
                : "No PR opened in this range has been approved yet."
          }
          hint={emptyHint(teamMembers)}
        />
      ) : (
        <>
          <Percentiles
            median={formatMs(summary.p50Ms)}
            p90={formatMs(summary.p90Ms)}
            samples={summary.approvedPRs}
          />
          <Sample>
            Covers the <Strong>{pluralize(summary.approvedPRs, "approved PR")}</Strong>, out of{" "}
            {reviewed.toLocaleString()} reviewed.
            {atFirstReview > 0 &&
              ` ${atFirstReview.toLocaleString()} ${
                atFirstReview === 1 ? "was" : "were"
              } approved at the first review, which counts as 0.`}
          </Sample>
          <DistributionBars
            rows={approvalRows(summary)}
            of="approved PRs"
            name="Time to approval"
          />
        </>
      )}
    </MetricCard>
  );
}

function ReviewRoundsCard({
  summary,
  teamMembers,
  includeBots,
}: {
  summary: RoundsSummary;
  teamMembers: string[];
  includeBots: boolean;
}) {
  const rows = summary.distribution.map((bucket) => ({ label: bucket.label, count: bucket.count }));
  return (
    <MetricCard
      id="review-rounds-heading"
      title="Review rounds"
      description="Change requests per merged PR that got a review, from any reviewer."
      notes={
        <>
          <LeftOut
            items={[
              { count: summary.mergedWithoutReviewPRs, label: "merged without a review" },
              { count: summary.undeterminedPRs, label: "with reviews that couldn't be fetched" },
            ]}
          />
          <p className={noteClass}>
            Two reviewers asking for changes make two rounds. A dismissed change request doesn't
            count, since GitHub no longer reports its state.
          </p>
          <ReviewerRules teamMembers={teamMembers} includeBots={includeBots} />
        </>
      }
    >
      {summary.reviewedMergedPRs === 0 ? (
        <EmptyState
          title={
            summary.undeterminedPRs > 0
              ? "No merged PR in this range has a known number of rounds."
              : "No PR opened in this range was merged after a review."
          }
          hint={emptyHint(teamMembers)}
        />
      ) : (
        <>
          <Percentiles
            median={<Rounds value={summary.p50} />}
            p90={<Rounds value={summary.p90} />}
            samples={summary.reviewedMergedPRs}
          />
          <Sample>
            Covers the <Strong>{pluralize(summary.reviewedMergedPRs, "merged PR")}</Strong> that got
            a review.
          </Sample>
          <DistributionBars rows={rows} of="reviewed merged PRs" name="Review rounds" />
        </>
      )}
    </MetricCard>
  );
}

export function ReviewCycleSection({ summary, teamMembers, includeBots }: ReviewCycleSectionProps) {
  return (
    <section aria-label="Merge and approval" className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <TimeToMergeCard summary={summary.timeToMerge} />
      <TimeToApprovalCard
        summary={summary.timeToApproval}
        teamMembers={teamMembers}
        includeBots={includeBots}
      />
      <ReviewRoundsCard
        summary={summary.reviewRounds}
        teamMembers={teamMembers}
        includeBots={includeBots}
      />
    </section>
  );
}
