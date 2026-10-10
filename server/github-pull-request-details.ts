import { github, type GraphqlVariable } from "./github-client.ts";
import type { GitHubRun } from "./github-run.ts";
import { parseRepo } from "./lib/parse-repo.ts";
import {
  batchAlias,
  fetchPullRequestsInBatches,
  pullRequestKey,
  readPullRequestBatch,
  type BatchEntry,
  type FetchedPullRequest,
  type PullRequestBatchResponse,
  type PullRequestRef,
} from "./pull-request-details.ts";
import {
  describeSchemaError,
  PULL_REQUEST_FIELDS,
  REVIEW_FIELDS,
  reviewConnectionSchema,
  type PRReview,
} from "./pull-request-model.ts";

// The GitHub calls behind pull-request-details.ts: the batch query and the review pages
// that follow a PR's inline reviews.

const REVIEW_PAGE_SIZE = 100;
// GitHub stops a query at about 10 s and answers 502 or 504. Without review request events,
// 50 PRs took about 4 s (2 points). With them, 50 of the busiest PRs of nodejs/node and
// microsoft/vscode took 10 to 11 s and timed out, while 25 take 3 to 7.5 s (1 point). The
// cost per PR is the same at both sizes, 1 point per 25 PRs, so 25 only adds calls.
const PR_BATCH_SIZE = 25;
const FETCH_CONCURRENCY = 5;

const PR_REVIEWS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes { ...ReviewFields }
      }
    }
  }
}
${REVIEW_FIELDS}`;

// One aliased pullRequest field per number, so a single request fetches a whole batch.
function buildPullRequestBatchQuery(numbers: number[]): string {
  const fields = numbers
    .map(
      (number) =>
        `    ${batchAlias(number)}: pullRequest(number: ${number}) { ...PullRequestFields }`,
    )
    .join("\n");
  return `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${fields}
  }
}
${PULL_REQUEST_FIELDS}`;
}

// `reviews` is parsed with reviewConnectionSchema before use.
interface ReviewsResponse {
  repository: {
    pullRequest: {
      reviews: unknown;
    } | null;
  } | null;
}

async function fetchPullRequestReviews(
  repo: string,
  number: number,
  after: string | null,
  run: GitHubRun,
): Promise<PRReview[]> {
  const { owner, name } = parseRepo(repo);
  let hasNextPage = true;
  let cursor = after;
  const reviews: PRReview[] = [];

  while (hasNextPage) {
    const variables: Record<string, GraphqlVariable> = {
      owner,
      name,
      number,
      first: REVIEW_PAGE_SIZE,
    };
    if (cursor !== null) variables.after = cursor;

    const data = await github.query<ReviewsResponse>(PR_REVIEWS_QUERY, variables, run);
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`Pull request ${repo}#${number} was not found while fetching reviews.`);
    }

    const page = reviewConnectionSchema.safeParse(pullRequest.reviews);
    if (!page.success) {
      throw new Error(
        `Unexpected review page for ${repo}#${number}: ${describeSchemaError(page.error)}`,
      );
    }
    reviews.push(...page.data.nodes);
    hasNextPage = page.data.pageInfo.hasNextPage;
    cursor = page.data.pageInfo.endCursor;
  }

  return reviews;
}

async function fetchPullRequestBatch(
  repo: string,
  numbers: number[],
  run: GitHubRun,
): Promise<BatchEntry[]> {
  const { owner, name } = parseRepo(repo);
  const response = await github.queryPartial<NonNullable<PullRequestBatchResponse["data"]>>(
    buildPullRequestBatchQuery(numbers),
    { owner, name },
    run,
  );
  return readPullRequestBatch({ repo, numbers, response });
}

// Fetches each PR's data and reviews in batches, one repo at a time. The map is keyed by
// pullRequestKey and has one entry per requested PR.
export async function fetchPullRequestDetails(
  refs: PullRequestRef[],
  run: GitHubRun,
): Promise<Map<string, FetchedPullRequest>> {
  const numbersByRepo = new Map<string, number[]>();
  for (const { repo, number } of refs) {
    const numbers = numbersByRepo.get(repo) ?? [];
    numbers.push(number);
    numbersByRepo.set(repo, numbers);
  }

  const fetched = new Map<string, FetchedPullRequest>();
  const repoCount = numbersByRepo.size;
  // PRs of the repos already done, so prsDone counts across repos.
  let prsBefore = 0;
  for (const [repoIndex, [repo, numbers]] of Array.from(numbersByRepo).entries()) {
    const results = await fetchPullRequestsInBatches({
      repo,
      numbers,
      batchSize: PR_BATCH_SIZE,
      concurrency: FETCH_CONCURRENCY,
      fetchBatch: (batch) => fetchPullRequestBatch(repo, batch, run),
      fetchContinuation: (pr) =>
        fetchPullRequestReviews(repo, pr.number, pr.reviews.pageInfo.endCursor, run),
      onProgress: ({
        prsDone,
        prsTotal,
        batchesDone,
        batchesTotal,
        reviewPRsDone,
        reviewPRsTotal,
      }) =>
        run.report({
          phase: "fetching",
          repo,
          repoIndex,
          repoCount,
          prsDone: prsBefore + prsDone,
          prsTotal: refs.length,
          repoPRsDone: prsDone,
          repoPRsTotal: prsTotal,
          batchesDone,
          batchesTotal,
          reviewPRsDone,
          reviewPRsTotal,
        }),
    });
    prsBefore += numbers.length;
    numbers.forEach((number, index) => {
      fetched.set(pullRequestKey({ repo, number }), results[index]);
    });
  }
  return fetched;
}
