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
