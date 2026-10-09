export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
export type TimeRangePreset = "week" | "month" | "quarter" | "year" | "all" | "custom";

// `__typename` is "User" for people and "Bot" for GitHub Apps; GitHub also returns
// "Mannequin", "Organization" and "EnterpriseUserAccount" in rare cases.
export interface Actor {
  login: string;
  __typename: string;
}

export interface PRReview {
  author: Actor | null;
  state: ReviewState;
  submittedAt: string | null;
  body: string;
}

// A conversation comment on the PR (not an inline review comment).
export interface PRComment {
  author: Actor | null;
  createdAt: string;
}

// Comments arrive oldest first and only the earliest qualifying one matters, but bots
// (CI, preview deploys, changesets) and the author often comment first, so one is not
// enough. Ten covers that for nearly every PR, and since only the author and timestamp
// are fetched, the search page barely grows: on honojs/hono for September 2026 it was
// 79.9 KB with 5, 81.6 KB with 10 and 83.5 KB with 20.
export const COMMENTS_PAGE_SIZE = 10;

export interface PullRequest {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  // When the PR first left draft; null if it never was a draft.
  readyForReviewAt: string | null;
  author: { login: string } | null;
  reviews: {
    nodes: PRReview[];
  };
  // The oldest COMMENTS_PAGE_SIZE comments at most.
  comments: {
    nodes: PRComment[];
  };
}

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
