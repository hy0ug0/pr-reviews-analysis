import { mapWithConcurrency } from "./lib/concurrency.ts";
import { createLogger } from "./logger.ts";
import {
  describeSchemaError,
  pullRequestNodeSchema,
  REVIEW_REQUEST_EVENTS_PAGE_SIZE,
  type PullRequest,
  type PullRequestNode,
} from "./pull-request-model.ts";
import {
  resolveReviews,
  type FetchReviewContinuation,
  type ResolvedPullRequest,
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

// "partial": the data is incomplete (only the inline reviews could be fetched, or the PR has
// more review request events than one page). "failed": no data at all.
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
// resolve and an error, with the alias in its path, for each one it could not. Each alias is
// parsed with pullRequestNodeSchema before use.
export interface PullRequestBatchResponse {
  data: { repository: Record<string, unknown> | null } | null;
  errors?: GraphqlError[];
}

export function batchAlias(number: number): string {
  return `pr${number}`;
}

// Maps a batch response to one entry per number. An error under an alias fails only that
// PR, even if the alias also has data, since that data may be incomplete. So does a node
// that does not match pullRequestNodeSchema.
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
    const raw = repository[alias];
    if (raw !== null && raw !== undefined) {
      const parsed = pullRequestNodeSchema.safeParse(raw);
      if (parsed.success) return { kind: "node", node: parsed.data };
      return {
        kind: "failed",
        reason: `Failed to fetch ${repo}#${number}: unexpected response (${describeSchemaError(parsed.error)})`,
      };
    }
    if (unattributed.length > 0) {
      return {
        kind: "failed",
        reason: `Failed to fetch ${repo}#${number}: ${unattributed.join(", ")}`,
      };
    }
    return { kind: "failed", reason: `Pull request ${repo}#${number} was not found.` };
  });
}

// The review request history past the first page is never fetched, so a PR with more is
// served once but never cached as complete.
function flagTruncatedReviewRequests(
  repo: string,
  resolved: ResolvedPullRequest,
): FetchedPullRequest {
  const { pullRequest } = resolved;
  if (resolved.kind === "partial" || !pullRequest.reviewRequests.pageInfo.hasNextPage) {
    return resolved;
  }
  return {
    kind: "partial",
    pullRequest,
    reason: `${repo}#${pullRequest.number} has more than ${REVIEW_REQUEST_EVENTS_PAGE_SIZE} review request events; reviewer response times use the first ${REVIEW_REQUEST_EVENTS_PAGE_SIZE}.`,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// How far one repo's fetch is. prsDone counts the PRs of finished batches, failed or not.
// reviewPRsTotal is null until every batch is done and the PRs needing more review pages
// are known.
export interface BatchFetchProgress {
  prsDone: number;
  prsTotal: number;
  batchesDone: number;
  batchesTotal: number;
  reviewPRsDone: number;
  reviewPRsTotal: number | null;
}

// Fetches the given PRs of one repo, `batchSize` per GraphQL call and `concurrency` calls at
// a time, then completes the reviews of PRs with more than one inline page. A failed batch
// fails only its own PRs. The result keeps the order of `numbers`. onProgress gets a
// snapshot before the first batch and after each batch and each extra review fetch.
export async function fetchPullRequestsInBatches({
  repo,
  numbers,
  batchSize,
  concurrency,
  fetchBatch,
  fetchContinuation,
  onProgress = () => {},
}: {
  repo: string;
  numbers: number[];
  batchSize: number;
  concurrency: number;
  fetchBatch: FetchPullRequestBatch;
  fetchContinuation: FetchReviewContinuation;
  onProgress?: (progress: BatchFetchProgress) => void;
}): Promise<FetchedPullRequest[]> {
  const batches = chunk(numbers, batchSize);
  log.info(
    `Fetching ${numbers.length} PRs in ${repo} in ${batches.length} batches of up to ${batchSize} (concurrency=${concurrency})`,
  );

  const progress: BatchFetchProgress = {
    prsDone: 0,
    prsTotal: numbers.length,
    batchesDone: 0,
    batchesTotal: batches.length,
    reviewPRsDone: 0,
    reviewPRsTotal: null,
  };
  const report = (changes: Partial<BatchFetchProgress>) => {
    Object.assign(progress, changes);
    onProgress({ ...progress });
  };
  const batchDone = (batch: number[]) =>
    report({
      prsDone: progress.prsDone + batch.length,
      batchesDone: progress.batchesDone + 1,
    });
  report({});

  const batchResults = await mapWithConcurrency(
    batches,
    concurrency,
    async (batch): Promise<BatchItem[]> => {
      try {
        const entries = await fetchBatch(batch);
        const failed = entries.filter((entry) => entry.kind === "failed").length;
        batchDone(batch);
        log.info(
          `Batch progress for ${repo}: ${progress.batchesDone}/${batches.length} completed${failed > 0 ? ` (${failed} PRs failed)` : ""}`,
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
        batchDone(batch);
        log.warn(
          `Batch fetch failed for ${repo} (${progress.batchesDone}/${batches.length}): ${message}`,
        );
        return batch.map((number) => ({
          kind: "failed",
          number,
          reason: `Failed to fetch ${repo}#${number}: ${message}`,
        }));
      }
    },
  );
  const items = batchResults.flat();

  const nodes = items.flatMap((item) => (item.kind === "node" ? [item.node] : []));
  // resolveReviews keeps the order of `nodes`, so the nth node item maps to resolved[n].
  const resolved = await resolveReviews({
    repo,
    prNodes: nodes,
    fetchContinuation,
    concurrency,
    onProgress: (done, total) => report({ reviewPRsDone: done, reviewPRsTotal: total }),
  });
  let resolvedIndex = 0;
  return items.map((item): FetchedPullRequest => {
    switch (item.kind) {
      case "node":
        return flagTruncatedReviewRequests(repo, resolved[resolvedIndex++]);
      case "failed":
        return item;
      default: {
        const _exhaustive: never = item;
        return _exhaustive;
      }
    }
  });
}
