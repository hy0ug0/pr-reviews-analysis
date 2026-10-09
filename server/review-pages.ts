import { createLogger } from "./logger.ts";
import { mapWithConcurrency } from "./lib/concurrency.ts";
import {
  toPullRequest,
  type PRReview,
  type PullRequest,
  type PullRequestNode,
  type ReviewConnection,
} from "./pull-request-model.ts";

const log = createLogger("fetch");

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

// Completes the reviews of PRs whose inline page has more after it, keeping PR order.
// A failed continuation keeps the inline reviews and marks that PR partial.
// onProgress gets the number of PRs whose extra pages are done, out of those that need them:
// once before the first fetch, then after each PR.
export async function resolveReviews({
  repo,
  prNodes,
  fetchContinuation,
  concurrency,
  onProgress = () => {},
}: {
  repo: string;
  prNodes: PullRequestNode[];
  fetchContinuation: FetchReviewContinuation;
  concurrency: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<ResolvedPullRequest[]> {
  const overflowPRs = prNodes.filter((pr) => pr.reviews.pageInfo.hasNextPage);
  onProgress(0, overflowPRs.length);
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
        onProgress(completedReviewFetches, overflowPRs.length);
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
          pullRequest: toPullRequest({
            repo,
            node: pr,
            reviews: mergeReviewPages(pr.reviews, remaining),
            hasMoreReviews: false,
          }),
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown review fetch error";
        completedReviewFetches++;
        onProgress(completedReviewFetches, overflowPRs.length);
        log.warn(
          `Review fetch failed for ${repo}#${pr.number} (${completedReviewFetches}/${overflowPRs.length}): ${message}`,
        );
        return {
          kind: "partial",
          pullRequest: toPullRequest({
            repo,
            node: pr,
            reviews: pr.reviews.nodes,
            hasMoreReviews: true,
          }),
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
        pullRequest: toPullRequest({
          repo,
          node: pr,
          reviews: pr.reviews.nodes,
          hasMoreReviews: false,
        }),
      },
  );
}
