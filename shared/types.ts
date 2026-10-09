export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
export type TimeRangePreset = "week" | "month" | "quarter" | "year" | "all" | "custom";

export interface PRReview {
  author: { login: string } | null;
  state: ReviewState;
  submittedAt: string | null;
  body: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: { login: string } | null;
  reviews: {
    nodes: PRReview[];
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

export interface AnalysisResult {
  matchingPRs: number;
  analyzedPRs: number;
  isComplete: boolean;
  partialReasons: string[];
  totalReviews: number;
  uniqueReviewers: number;
  avgReviewsPerPR: number;
  reviewerStats: ReviewerStats[];
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
