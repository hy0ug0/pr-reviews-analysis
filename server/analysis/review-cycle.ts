import type {
  PullRequest,
  ReviewCycleSummary,
  ReviewRoundsBucket,
  ReviewRoundsSummary,
  ReviewState,
  TimeToApprovalSummary,
  TimeToMergeSummary,
} from "../../shared/types.ts";
import { responseStart, unfetchedAfter } from "./first-response.ts";
import {
  isParticipant,
  toParticipantRules,
  type ParticipantOptions,
  type ParticipantRules,
} from "./participants.ts";
import { buildHistogram, percentile, roundedPercentile } from "./stats.ts";

// Three metrics of the review cycle, after the first response: time to merge, time from the
// first review to the first approval, and review rounds. Like first response, they cover
// every listed PR (created in the range, minus bot PRs when bots are excluded), whatever the
// date of the review or the merge: a PR created in the range and merged after it counts.
// Times are epoch milliseconds.

export type MergeOutcome =
  | { kind: "merged"; startedAt: number; mergedAt: number }
  | { kind: "open" }
  | { kind: "closedUnmerged" };

export type ApprovalOutcome =
  | { kind: "draft" }
  | { kind: "unreviewed" }
  | { kind: "approved"; firstReviewAt: number; approvedAt: number }
  | { kind: "notApproved" }
  // More reviews exist than were fetched and none of the fetched ones is an approval: an
  // unseen review may be the first approval.
  | { kind: "undetermined" };

export type RoundsOutcome =
  | { kind: "notMerged" }
  | { kind: "mergedWithoutReview" }
  | { kind: "counted"; rounds: number }
  // More reviews exist than were fetched, and an unseen one could be a change request made
  // before the merge.
  | { kind: "undetermined" };

interface TimedReview {
  state: ReviewState;
  time: number;
}

function closedTime(pr: PullRequest): number | null {
  return pr.state === "OPEN" || pr.closedAt === null ? null : Date.parse(pr.closedAt);
}

// Submitted reviews (any state but PENDING) by participants, between the response start and
// the closing, oldest first. The window is first response's: a review of a draft isn't part
// of the review cycle, and neither is one after the merge.
function cycleReviews(pr: PullRequest, rules: ParticipantRules): TimedReview[] {
  const startedAt = responseStart(pr);
  const closedAt = closedTime(pr);
  return pr.reviews.nodes
    .flatMap((review) => {
      if (review.state === "PENDING" || review.submittedAt === null) return [];
      if (!isParticipant(review.author, pr, rules)) return [];
      const time = Date.parse(review.submittedAt);
      if (time < startedAt || (closedAt !== null && time > closedAt)) return [];
      return [{ state: review.state, time }];
    })
    .sort((a, b) => a.time - b.time);
}

// Whether reviews GitHub has but didn't return could still fall in the cycle: they come after
// the last fetched one (see unfetchedAfter), so they matter while the PR was open then. With no
// fetched review submitted, nothing bounds them.
function mayMissReviews(pr: PullRequest): boolean {
  if (!pr.reviews.pageInfo.hasNextPage) return false;
  const after = unfetchedAfter(pr).reviews;
  if (after === null) return true;
  const closedAt = closedTime(pr);
  return closedAt === null || after <= closedAt;
}

// From the response start (creation or first ready for review, as in first response) to the
// merge. Whether anyone reviewed doesn't matter: a PR merged without review counts. A PR is
// never merged as a draft, so drafts are open or closed.
export function classifyMerge(pr: PullRequest): MergeOutcome {
  if (pr.state === "OPEN") return { kind: "open" };
  if (pr.state !== "MERGED" || pr.mergedAt === null) return { kind: "closedUnmerged" };
  const startedAt = responseStart(pr);
  // A ready-for-review event after the merge would be a data error; it never gives a
  // negative duration.
  return { kind: "merged", startedAt, mergedAt: Math.max(startedAt, Date.parse(pr.mergedAt)) };
}

// From the first participant review to the first participant approval, both in the cycle
// window. The first review is any submitted review: an approval, a change request, a comment
// review, or a dismissed review, whose original state GitHub no longer reports. A PR whose
// first review is the approval takes 0. A dismissed approval comes back as DISMISSED, so it
// never ends the clock: the approval that counts is one that still stands. Drafts are left
// out, as in first response.
export function classifyApproval({
  pr,
  ...rules
}: { pr: PullRequest } & ParticipantRules): ApprovalOutcome {
  if (pr.isDraft) return { kind: "draft" };

  const reviews = cycleReviews(pr, rules);
  const approval = reviews.find((review) => review.state === "APPROVED");
  // Unseen reviews come after every fetched one, so a fetched approval is the first.
  if (approval)
    return { kind: "approved", firstReviewAt: reviews[0].time, approvedAt: approval.time };
  if (mayMissReviews(pr)) return { kind: "undetermined" };
  return reviews.length > 0 ? { kind: "notApproved" } : { kind: "unreviewed" };
}

// The number of participant CHANGES_REQUESTED reviews in the cycle window, over merged PRs
// with at least one participant review. Merged PRs only, because an open PR may get more
// rounds. Two reviewers asking for changes count as two rounds. A change request later
// dismissed comes back as DISMISSED and isn't counted.
export function classifyRounds({
  pr,
  ...rules
}: { pr: PullRequest } & ParticipantRules): RoundsOutcome {
  if (pr.state !== "MERGED") return { kind: "notMerged" };
  if (mayMissReviews(pr)) return { kind: "undetermined" };
  const reviews = cycleReviews(pr, rules);
  if (reviews.length === 0) return { kind: "mergedWithoutReview" };
  const rounds = reviews.filter((review) => review.state === "CHANGES_REQUESTED").length;
  return { kind: "counted", rounds };
}

// The last bucket holds every higher count.
const ROUND_BUCKETS = [0, 1, 2, 3];

function oneDecimal(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function summarizeMerge(prs: readonly PullRequest[]): TimeToMergeSummary {
  const durations: number[] = [];
  const counts = { open: 0, closedUnmerged: 0 };
  for (const pr of prs) {
    const outcome = classifyMerge(pr);
    if (outcome.kind === "merged") durations.push(outcome.mergedAt - outcome.startedAt);
    else counts[outcome.kind]++;
  }
  durations.sort((a, b) => a - b);
  return {
    mergedPRs: durations.length,
    openPRs: counts.open,
    closedUnmergedPRs: counts.closedUnmerged,
    p50Ms: roundedPercentile(durations, 0.5),
    p90Ms: roundedPercentile(durations, 0.9),
    histogram: buildHistogram(durations),
  };
}

function summarizeApproval({
  prs,
  rules,
}: {
  prs: readonly PullRequest[];
  rules: ParticipantRules;
}): TimeToApprovalSummary {
  const durations: number[] = [];
  const counts = { draft: 0, unreviewed: 0, notApproved: 0, undetermined: 0 };
  for (const pr of prs) {
    const outcome = classifyApproval({ pr, ...rules });
    switch (outcome.kind) {
      case "approved":
        durations.push(outcome.approvedAt - outcome.firstReviewAt);
        break;
      case "draft":
      case "unreviewed":
      case "notApproved":
      case "undetermined":
        counts[outcome.kind]++;
        break;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }
  durations.sort((a, b) => a - b);
  return {
    approvedPRs: durations.length,
    approvedAtFirstReviewPRs: durations.filter((duration) => duration === 0).length,
    notApprovedPRs: counts.notApproved,
    unreviewedPRs: counts.unreviewed,
    draftPRs: counts.draft,
    undeterminedPRs: counts.undetermined,
    p50Ms: roundedPercentile(durations, 0.5),
    p90Ms: roundedPercentile(durations, 0.9),
    histogram: buildHistogram(durations),
  };
}

function summarizeRounds({
  prs,
  rules,
}: {
  prs: readonly PullRequest[];
  rules: ParticipantRules;
}): ReviewRoundsSummary {
  const rounds: number[] = [];
  const counts = { mergedWithoutReview: 0, undetermined: 0 };
  for (const pr of prs) {
    const outcome = classifyRounds({ pr, ...rules });
    switch (outcome.kind) {
      case "counted":
        rounds.push(outcome.rounds);
        break;
      case "mergedWithoutReview":
      case "undetermined":
        counts[outcome.kind]++;
        break;
      case "notMerged":
        break;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }
  rounds.sort((a, b) => a - b);
  const last = ROUND_BUCKETS.length - 1;
  const distribution: ReviewRoundsBucket[] = ROUND_BUCKETS.map((bucket, index) => {
    const orMore = index === last;
    return {
      label: orMore ? `${bucket}+` : String(bucket),
      rounds: bucket,
      orMore,
      count: rounds.filter((count) => (orMore ? count >= bucket : count === bucket)).length,
    };
  });
  return {
    reviewedMergedPRs: rounds.length,
    mergedWithoutReviewPRs: counts.mergedWithoutReview,
    undeterminedPRs: counts.undetermined,
    p50: oneDecimal(percentile(rounds, 0.5)),
    p90: oneDecimal(percentile(rounds, 0.9)),
    distribution,
  };
}

export function summarizeReviewCycle({
  prs,
  ...participantOptions
}: { prs: readonly PullRequest[] } & ParticipantOptions): ReviewCycleSummary {
  const rules = toParticipantRules(participantOptions);
  return {
    timeToMerge: summarizeMerge(prs),
    timeToApproval: summarizeApproval({ prs, rules }),
    reviewRounds: summarizeRounds({ prs, rules }),
  };
}
