export type TimeRangePreset = "week" | "month" | "quarter" | "year" | "all" | "custom";

// The pull request model lives with its schemas and GraphQL fragment on the server.
export type {
  Actor,
  PRComment,
  PRReview,
  PullRequest,
  RequestedReviewer,
  ReviewRequestEvent,
  ReviewState,
} from "../server/pull-request-model";

// Comments arrive oldest first and only the earliest qualifying one matters, but bots
// (CI, preview deploys, changesets) and the author often comment first, so one is not
// enough. Ten covers that for nearly every PR, and since only the author and timestamp
// are fetched, the search page barely grows: on honojs/hono for September 2026 it was
// 79.9 KB with 5, 81.6 KB with 10 and 83.5 KB with 20.
export const COMMENTS_PAGE_SIZE = 10;

export interface ReviewerStats {
  login: string;
  totalReviews: number;
  approvals: number;
  changesRequested: number;
  comments: number;
  prsReviewed: number;
  // Time from a review request (to the reviewer or one of their teams) to their next review
  // or comment, over every request they answered; null without a sample.
  responseP50Ms: number | null;
  responseP90Ms: number | null;
  responseSamples: number;
}

export interface DurationBucket {
  label: string;
  minMs: number;
  // Exclusive; null for the open-ended last bucket.
  maxMs: number | null;
  count: number;
}

export interface WeeklyFirstResponse {
  // Monday 00:00 UTC, as YYYY-MM-DD.
  weekStart: string;
  // Null for a week where no PR got a response.
  p50Ms: number | null;
  count: number;
}

export interface FirstResponseSummary {
  respondedPRs: number;
  waitingPRs: number;
  closedWithoutResponsePRs: number;
  draftPRs: number;
  // More comments than were fetched, none of them a response, and no earlier review.
  undeterminedPRs: number;
  // Null when no PR got a response.
  p50Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
  histogram: DurationBucket[];
  weekly: WeeklyFirstResponse[];
}

// From ready for review (as in first response) to the merge, over the merged PRs. Open PRs
// and PRs closed without merging have no duration.
export interface TimeToMergeSummary {
  mergedPRs: number;
  openPRs: number;
  closedUnmergedPRs: number;
  // Null when no PR was merged.
  p50Ms: number | null;
  p90Ms: number | null;
  histogram: DurationBucket[];
}

// From a PR's first review to its first approval that wasn't dismissed, both by participants.
export interface TimeToApprovalSummary {
  approvedPRs: number;
  // Of approvedPRs, those whose first review was the approval: a duration of 0.
  approvedAtFirstReviewPRs: number;
  // Reviewed, but no approval that still stands.
  notApprovedPRs: number;
  unreviewedPRs: number;
  draftPRs: number;
  // More reviews than were fetched and no approval among the fetched ones.
  undeterminedPRs: number;
  // Null when no PR was approved.
  p50Ms: number | null;
  p90Ms: number | null;
  histogram: DurationBucket[];
}

export interface ReviewRoundsBucket {
  label: string;
  rounds: number;
  // Whether the bucket also holds every higher count, as the last one does ("3+").
  orMore: boolean;
  count: number;
}

// Change requests per merged PR that got a review.
export interface ReviewRoundsSummary {
  reviewedMergedPRs: number;
  mergedWithoutReviewPRs: number;
  // More reviews than were fetched, so some change requests may be missing.
  undeterminedPRs: number;
  // Rounds per PR, to one decimal; null when no merged PR got a review.
  p50: number | null;
  p90: number | null;
  distribution: ReviewRoundsBucket[];
}

export interface ReviewCycleSummary {
  timeToMerge: TimeToMergeSummary;
  timeToApproval: TimeToApprovalSummary;
  reviewRounds: ReviewRoundsSummary;
}

// How many of the PRs the query matches were analyzed, and why some are missing.
export interface AnalysisCoverage {
  matchingPRs: number;
  analyzedPRs: number;
  isComplete: boolean;
  partialReasons: string[];
}

// What excluding bots left out of the metrics: the PRs bots opened, and the reviews by bots
// that would count if bots were included.
export interface ExcludedBots {
  prs: number;
  reviews: number;
}

// What analyze() computes from the loaded PRs.
export interface AnalysisMetrics {
  // The PRs every metric counts: the analyzed PRs, minus those bots opened when bots are
  // excluded.
  countedPRs: number;
  // Null when the request included bots.
  excludedBots: ExcludedBots | null;
  totalReviews: number;
  uniqueReviewers: number;
  avgReviewsPerPR: number;
  reviewerStats: ReviewerStats[];
  firstResponse: FirstResponseSummary;
  reviewCycle: ReviewCycleSummary;
  timeRange: { since: string; until: string };
}

export interface AnalysisResult extends AnalysisCoverage, AnalysisMetrics {
  dataSource?: DataSource;
}

// Where the data behind an analysis came from. `listing` says whether the PR list for the
// query was read from the cache or searched on GitHub; the counts split the listed PRs
// between those fetched from GitHub on this request and those reused from the PR cache.
export interface DataSource {
  listing: "cache" | "github";
  listedAt: string;
  fetchedPRs: number;
  reusedPRs: number;
  // When the oldest reused PR was cached; null when no PR was reused.
  oldestReusedCachedAt: string | null;
  // GraphQL calls this run made, retries included. 0 when everything came from the cache.
  githubRequests: number;
  // Wall time spent listing and fetching on GitHub; null when the run made no request.
  fetchDurationMs: number | null;
  // The request asked to skip the cache, so the PR list was searched on GitHub again.
  skippedCache: boolean;
}

// One repo's listing. `matching` is the repo's total for the range, known after its first
// page. A range with more than 1,000 PRs is split into date windows, listed one by one:
// windowsTotal grows when a window is split, and windowsDone reaches it once the repo is
// listed.
export interface RepoListingProgress {
  repo: string;
  listed: number;
  matching: number | null;
  page: number;
  windowsDone: number;
  windowsTotal: number;
}

// One repo's fetch. prsDone counts the PRs of finished batches, failed or not.
// reviewPRsTotal, the PRs needing more review pages, is null until every batch is done.
export interface RepoFetchProgress {
  repo: string;
  prsDone: number;
  prsTotal: number;
  batchesDone: number;
  batchesTotal: number;
  reviewPRsDone: number;
  reviewPRsTotal: number | null;
}

// Where an analysis run is, sent to the client while it waits. Every event is a full
// snapshot, so a client that joins late or misses one still shows the right state. Repos are
// listed and fetched side by side, so those steps carry one entry per repo, in query order;
// the client sums them for the totals. While a GitHub request waits for the rate limit,
// listing and fetching carry rateLimitedUntil, an ISO time.
export type AnalysisProgress =
  // Reading the PR list from the cache, which may send the run to GitHub.
  | { phase: "listing-cache" }
  // Searching the PR list on GitHub, one entry per repo of the query.
  | { phase: "listing"; repos: RepoListingProgress[]; rateLimitedUntil?: string }
  // Matching the listed PRs against the PR cache.
  | { phase: "pr-cache"; prs: number }
  // Fetching the PRs the cache could not serve, one entry per repo with PRs to fetch.
  | { phase: "fetching"; repos: RepoFetchProgress[]; rateLimitedUntil?: string }
  // Computing the metrics, the last step.
  | { phase: "analyzing"; prs: number };

export interface AnalyzeParams {
  repos: string[];
  label?: string;
  since?: string;
  until?: string;
  teamMembers?: string[];
  // Bots are excluded unless this is true.
  includeBots?: boolean;
}

export interface AppDefaults {
  repos: string;
  label: string;
  team: string;
}

export interface AppSuggestion {
  value: string;
  detail?: string;
  color?: string;
  isPrivate?: boolean;
}
