import type { PRReview, PullRequest } from "../shared/types.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("fetch");

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

// Fetches the review pages that follow `pr.reviews.pageInfo.endCursor`,
// or every review when that cursor is null.
export type FetchReviewContinuation = (pr: SearchPullRequestNode) => Promise<PRReview[]>;

export interface ResolvedReviews {
  prs: PullRequest[];
  isComplete: boolean;
  partialReasons: string[];
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

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: Array<R | undefined> = Array.from({ length: items.length });
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Concurrency mapping failed at index ${index}.`);
    }
    return result;
  });
}

// Completes the reviews of PRs whose inline page has more after it, keeping PR order.
// A failed continuation keeps the inline reviews and marks the result partial.
export async function resolveReviews({
  repo,
  prNodes,
  fetchContinuation,
  concurrency,
}: {
  repo: string;
  prNodes: SearchPullRequestNode[];
  fetchContinuation: FetchReviewContinuation;
  concurrency: number;
}): Promise<ResolvedReviews> {
  const overflowPRs = prNodes.filter((pr) => pr.reviews.pageInfo.hasNextPage);
  log.info(
    `${overflowPRs.length}/${prNodes.length} PRs in ${repo} need extra review pages (concurrency=${concurrency})`,
  );
  let completedReviewFetches = 0;
  const continuedPRs = await mapWithConcurrency(
    overflowPRs,
    concurrency,
    async (pr): Promise<{ pullRequest: PullRequest; isComplete: boolean; reason?: string }> => {
      try {
        const remaining = await fetchContinuation(pr);
        completedReviewFetches++;
        if (
          overflowPRs.length <= 20 ||
          completedReviewFetches % 10 === 0 ||
          completedReviewFetches === overflowPRs.length
        ) {
          log.info(
            `Review fetch progress for ${repo}: ${completedReviewFetches}/${overflowPRs.length} PRs completed`,
          );
        }
        return {
          pullRequest: toPullRequest(pr, mergeReviewPages(pr.reviews, remaining)),
          isComplete: true,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown review fetch error";
        completedReviewFetches++;
        log.warn(
          `Review fetch failed for ${repo}#${pr.number} (${completedReviewFetches}/${overflowPRs.length}): ${message}`,
        );
        return {
          pullRequest: toPullRequest(pr, pr.reviews.nodes),
          isComplete: false,
          reason: `Failed to fetch complete reviews for ${repo}#${pr.number}: ${message}`,
        };
      }
    },
  );
  const continuedByNumber = new Map(continuedPRs.map((item) => [item.pullRequest.number, item]));

  const prs: PullRequest[] = [];
  const partialReasons: string[] = [];
  let isComplete = true;
  for (const pr of prNodes) {
    const item = continuedByNumber.get(pr.number) ?? {
      pullRequest: toPullRequest(pr, pr.reviews.nodes),
      isComplete: true,
    };
    prs.push(item.pullRequest);
    if (!item.isComplete) {
      isComplete = false;
      if (item.reason) partialReasons.push(item.reason);
    }
  }

  return { prs, isComplete, partialReasons };
}
