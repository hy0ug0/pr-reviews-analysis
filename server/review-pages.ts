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

// A PR node selected with the PullRequestFields fragment, carrying the first page of its
// reviews.
export interface PullRequestNode extends Omit<PullRequest, "reviews"> {
  reviews: ReviewConnection;
}

// Fetches the review pages that follow `pr.reviews.pageInfo.endCursor`,
// or every review when that cursor is null.
export type FetchReviewContinuation = (pr: PullRequestNode) => Promise<PRReview[]>;

// "partial": the continuation failed, so `pullRequest` holds only the inline reviews.
export type ResolvedPullRequest =
  | { kind: "complete"; pullRequest: PullRequest }
  | { kind: "partial"; pullRequest: PullRequest; reason: string };

// `remaining` holds the pages fetched from the inline connection's endCursor.
export function mergeReviewPages(inline: ReviewConnection, remaining: PRReview[]): PRReview[] {
  // Without a cursor the continuation restarted from the first review.
  if (inline.pageInfo.endCursor === null) return remaining;
  return [...inline.nodes, ...remaining];
}

// Drops the nested pageInfo so the result matches the shared PullRequest shape.
export function toPullRequest(node: PullRequestNode, reviews: PRReview[]): PullRequest {
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

// Caps a list of partial fetch reasons so the response stays readable.
export function uniqueReasons(reasons: string[]): string[] {
  const unique = Array.from(new Set(reasons.filter(Boolean)));
  if (unique.length <= 5) return unique;
  const omitted = unique.length - 4;
  return [...unique.slice(0, 4), `${omitted} additional partial fetch issue(s) omitted.`];
}

// Completes the reviews of PRs whose inline page has more after it, keeping PR order.
// A failed continuation keeps the inline reviews and marks that PR partial.
export async function resolveReviews({
  repo,
  prNodes,
  fetchContinuation,
  concurrency,
}: {
  repo: string;
  prNodes: PullRequestNode[];
  fetchContinuation: FetchReviewContinuation;
  concurrency: number;
}): Promise<ResolvedPullRequest[]> {
  const overflowPRs = prNodes.filter((pr) => pr.reviews.pageInfo.hasNextPage);
  log.info(
    `${overflowPRs.length}/${prNodes.length} PRs in ${repo} need extra review pages (concurrency=${concurrency})`,
  );
  let completedReviewFetches = 0;
  const continuedPRs = await mapWithConcurrency(
    overflowPRs,
    concurrency,
    async (pr): Promise<ResolvedPullRequest> => {
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
          kind: "complete",
          pullRequest: toPullRequest(pr, mergeReviewPages(pr.reviews, remaining)),
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown review fetch error";
        completedReviewFetches++;
        log.warn(
          `Review fetch failed for ${repo}#${pr.number} (${completedReviewFetches}/${overflowPRs.length}): ${message}`,
        );
        return {
          kind: "partial",
          pullRequest: toPullRequest(pr, pr.reviews.nodes),
          reason: `Failed to fetch complete reviews for ${repo}#${pr.number}: ${message}`,
        };
      }
    },
  );
  const continuedByNumber = new Map(continuedPRs.map((item) => [item.pullRequest.number, item]));

  return prNodes.map(
    (pr) =>
      continuedByNumber.get(pr.number) ?? {
        kind: "complete",
        pullRequest: toPullRequest(pr, pr.reviews.nodes),
      },
  );
}
