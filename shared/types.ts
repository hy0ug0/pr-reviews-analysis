export type TimeRangePreset = "week" | "month" | "quarter" | "year" | "all" | "custom";

// The pull request model lives with its schemas and GraphQL fragment on the server.
export type {
  Actor,
  PRComment,
  PRReview,
  PullRequest,
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

export interface AnalysisResult {
  matchingPRs: number;
  analyzedPRs: number;
  isComplete: boolean;
  partialReasons: string[];
  totalReviews: number;
  uniqueReviewers: number;
  avgReviewsPerPR: number;
  reviewerStats: ReviewerStats[];
  firstResponse: FirstResponseSummary;
  timeRange: { since: string; until: string };
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
}

export interface AnalyzeParams {
  repos: string[];
  label?: string;
  since?: string;
  until?: string;
  teamMembers?: string[];
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
