import type { PRReview, PullRequest } from "../shared/types.ts";

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ReviewConnection {
  pageInfo: PageInfo;
  nodes: PRReview[];
}

// A PR node from PR_SEARCH_QUERY, carrying the first page of its reviews.
export interface SearchPullRequestNode extends Omit<PullRequest, "reviews"> {
  reviews: ReviewConnection;
}

// `remaining` holds the pages fetched from the inline connection's endCursor.
export function mergeReviewPages(inline: ReviewConnection, remaining: PRReview[]): PRReview[] {
  // Without a cursor the continuation restarted from the first review.
  if (inline.pageInfo.endCursor === null) return remaining;
  return [...inline.nodes, ...remaining];
}

// Drops the nested pageInfo so the result matches the shared PullRequest shape.
export function toPullRequest(node: SearchPullRequestNode, reviews: PRReview[]): PullRequest {
  const { reviews: _connection, ...pullRequest } = node;
  return {
    ...pullRequest,
    reviews: { nodes: reviews },
  };
}
