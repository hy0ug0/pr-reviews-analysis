import type { PullRequest } from "../shared/types.ts";
import { createLogger } from "./logger.ts";
import {
  mapWithConcurrency,
  resolveReviews,
  type FetchReviewContinuation,
  type PullRequestNode,
} from "./review-pages.ts";

const log = createLogger("fetch");

export interface PullRequestRef {
  repo: string;
  number: number;
}

// Repos are normalized to lowercase before listing, so this key is stable across requests.
export function pullRequestKey({ repo, number }: PullRequestRef): string {
  return `${repo}#${number}`;
}

// "partial": only the inline reviews could be fetched. "failed": no data at all.
export type FetchedPullRequest =
  | { kind: "complete"; pullRequest: PullRequest }
  | { kind: "partial"; pullRequest: PullRequest; reason: string }
  | { kind: "failed"; number: number; reason: string };

type FailedPullRequest = Extract<FetchedPullRequest, { kind: "failed" }>;
type BatchItem = { kind: "node"; node: PullRequestNode } | FailedPullRequest;

// Returns one entry per requested number, in the same order; null when GitHub has no such PR.
export type FetchPullRequestBatch = (numbers: number[]) => Promise<Array<PullRequestNode | null>>;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// Fetches the given PRs of one repo, `batchSize` per GraphQL call and `concurrency` calls at
// a time, then completes the reviews of PRs with more than one inline page. A failed batch
// fails only its own PRs. The result keeps the order of `numbers`.
export async function fetchPullRequestsInBatches({
  repo,
  numbers,
  batchSize,
  concurrency,
  fetchBatch,
  fetchContinuation,
}: {
  repo: string;
  numbers: number[];
  batchSize: number;
  concurrency: number;
  fetchBatch: FetchPullRequestBatch;
  fetchContinuation: FetchReviewContinuation;
}): Promise<FetchedPullRequest[]> {
  const batches = chunk(numbers, batchSize);
  log.info(
    `Fetching ${numbers.length} PRs in ${repo} in ${batches.length} batches of up to ${batchSize} (concurrency=${concurrency})`,
  );

  let completedBatches = 0;
  const batchResults = await mapWithConcurrency(
    batches,
    concurrency,
    async (batch): Promise<BatchItem[]> => {
      try {
        const nodes = await fetchBatch(batch);
        completedBatches++;
        log.info(`Batch progress for ${repo}: ${completedBatches}/${batches.length} completed`);
        return batch.map((number, index): BatchItem => {
          const node = nodes[index];
          if (node) return { kind: "node", node };
          return {
            kind: "failed",
            number,
            reason: `Pull request ${repo}#${number} was not found.`,
          };
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown batch fetch error";
        completedBatches++;
        log.warn(
          `Batch fetch failed for ${repo} (${completedBatches}/${batches.length}): ${message}`,
        );
        return batch.map(
          (number): BatchItem => ({
            kind: "failed",
            number,
            reason: `Failed to fetch ${repo}#${number}: ${message}`,
          }),
        );
      }
    },
  );
  const items = batchResults.flat();

  const nodes = items.flatMap((item) => (item.kind === "node" ? [item.node] : []));
  // resolveReviews keeps the order of `nodes`, so the nth node item maps to resolved[n].
  const resolved = await resolveReviews({ repo, prNodes: nodes, fetchContinuation, concurrency });
  let resolvedIndex = 0;
  return items.map((item): FetchedPullRequest => {
    switch (item.kind) {
      case "node":
        return resolved[resolvedIndex++];
      case "failed":
        return item;
      default: {
        const _exhaustive: never = item;
        return _exhaustive;
      }
    }
  });
}
