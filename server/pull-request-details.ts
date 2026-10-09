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

// One requested PR in a batch response: its node, or why it has none.
export type BatchEntry =
  | { kind: "node"; node: PullRequestNode }
  | { kind: "failed"; reason: string };

// Returns one entry per requested number, in the same order.
export type FetchPullRequestBatch = (numbers: number[]) => Promise<BatchEntry[]>;

export interface GraphqlError {
  message: string;
  path?: Array<string | number>;
}

// A batch query response, possibly partial: GitHub returns data for the aliases it could
// resolve and an error, with the alias in its path, for each one it could not.
export interface PullRequestBatchResponse {
  data: { repository: Record<string, PullRequestNode | null> | null } | null;
  errors?: GraphqlError[];
}

export function batchAlias(number: number): string {
  return `pr${number}`;
}

// Maps a batch response to one entry per number. An error under an alias fails only that
// PR, even if the alias also has data, since that data may be incomplete.
export function readPullRequestBatch({
  repo,
  numbers,
  response,
}: {
  repo: string;
  numbers: number[];
  response: PullRequestBatchResponse;
}): BatchEntry[] {
  const errors = response.errors ?? [];
  const repository = response.data?.repository;
  if (!repository) {
    const messages = errors.map((error) => error.message).join(", ");
    throw new Error(messages || `Repository ${repo} was not found.`);
  }

  const aliases = new Set(numbers.map(batchAlias));
  const errorsByAlias = new Map<string, string[]>();
  const unattributed: string[] = [];
  for (const error of errors) {
    const alias = error.path?.find(
      (segment): segment is string => typeof segment === "string" && aliases.has(segment),
    );
    if (alias === undefined) {
      unattributed.push(error.message);
      continue;
    }
    errorsByAlias.set(alias, [...(errorsByAlias.get(alias) ?? []), error.message]);
  }

  return numbers.map((number): BatchEntry => {
    const alias = batchAlias(number);
    const aliasErrors = errorsByAlias.get(alias);
    if (aliasErrors) {
      return {
        kind: "failed",
        reason: `Failed to fetch ${repo}#${number}: ${aliasErrors.join(", ")}`,
      };
    }
    const node = repository[alias];
    if (node) return { kind: "node", node };
    if (unattributed.length > 0) {
      return {
        kind: "failed",
        reason: `Failed to fetch ${repo}#${number}: ${unattributed.join(", ")}`,
      };
    }
    return { kind: "failed", reason: `Pull request ${repo}#${number} was not found.` };
  });
}

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
        const entries = await fetchBatch(batch);
        completedBatches++;
        const failed = entries.filter((entry) => entry.kind === "failed").length;
        log.info(
          `Batch progress for ${repo}: ${completedBatches}/${batches.length} completed${failed > 0 ? ` (${failed} PRs failed)` : ""}`,
        );
        return batch.map((number, index): BatchItem => {
          const entry = entries[index];
          switch (entry.kind) {
            case "node":
              return entry;
            case "failed":
              return { kind: "failed", number, reason: entry.reason };
            default: {
              const _exhaustive: never = entry;
              return _exhaustive;
            }
          }
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
