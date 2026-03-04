import { execFile } from "node:child_process";
import type { PRReview, PullRequest } from "../shared/types.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("fetch");

const SEARCH_PAGE_SIZE = 100;
const REVIEW_PAGE_SIZE = 100;
const SEARCH_HARD_LIMIT = 1000;
const MAX_SEARCH_PAGES = SEARCH_HARD_LIMIT / SEARCH_PAGE_SIZE;
const REVIEW_FETCH_CONCURRENCY = 5;
const GRAPHQL_MAX_ATTEMPTS = 3;
const GITHUB_EPOCH_DATE = "2008-01-01";
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const PR_SEARCH_QUERY = `
query($searchQuery: String!, $first: Int!, $after: String) {
  search(first: $first, query: $searchQuery, type: ISSUE, after: $after) {
    issueCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        title
        state
        url
        createdAt
        mergedAt
        closedAt
        author { login }
      }
    }
  }
}`;

const PR_REVIEWS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author { login }
          state
          submittedAt
          body
        }
      }
    }
  }
}`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

type PullRequestWithoutReviews = Omit<PullRequest, "reviews">;

interface SearchResponse {
  search: {
    issueCount: number;
    pageInfo: PageInfo;
    nodes: PullRequestWithoutReviews[];
  };
}

interface ReviewsResponse {
  repository: {
    pullRequest: {
      reviews: {
        pageInfo: PageInfo;
        nodes: PRReview[];
      };
    } | null;
  } | null;
}

interface DateWindow {
  since: string;
  until: string;
}

interface FetchWindowResult {
  issueCount: number;
  prs: PullRequestWithoutReviews[];
  isComplete: boolean;
  partialReasons: string[];
}

interface RepoFetchResult {
  prs: PullRequest[];
  matchingPRs: number;
  isComplete: boolean;
  partialReasons: string[];
}

export interface PullRequestFetchResult {
  prs: PullRequest[];
  matchingPRs: number;
  analyzedPRs: number;
  isComplete: boolean;
  partialReasons: string[];
}

type GraphqlVariable = boolean | number | string | null | undefined;

interface GraphqlResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

function ghGraphql<T>(query: string, variables: Record<string, GraphqlVariable> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const args = ["api", "graphql", "-f", `query=${query}`];

    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "number" || typeof value === "boolean") {
        args.push("-F", `${key}=${value}`);
      } else {
        args.push("-f", `${key}=${String(value)}`);
      }
    }

    execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message);
        if (err.code === "ENOENT") {
          reject(new Error("GitHub CLI (gh) not found. Install from https://cli.github.com"));
        } else {
          reject(new Error(message));
        }
        return;
      }

      try {
        const response: GraphqlResponse<T> = JSON.parse(String(stdout));
        if (response.errors?.length) {
          reject(new Error(response.errors.map((e: { message: string }) => e.message).join(", ")));
          return;
        }
        resolve(response.data);
      } catch {
        reject(new Error("Failed to parse GitHub API response"));
      }
    });
  });
}

async function ghGraphqlWithRetry<T>(
  query: string,
  variables: Record<string, GraphqlVariable> = {},
): Promise<T> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < GRAPHQL_MAX_ATTEMPTS) {
    try {
      return await ghGraphql<T>(query, variables);
    } catch (error: unknown) {
      attempt++;
      lastError = error instanceof Error ? error : new Error("Unknown GitHub GraphQL error");
      log.warn(
        `GraphQL request failed (attempt ${attempt}/${GRAPHQL_MAX_ATTEMPTS}): ${lastError.message}`,
      );
      if (attempt >= GRAPHQL_MAX_ATTEMPTS) break;

      const backoffMs = 200 * 2 ** (attempt - 1);
      log.warn(`Retrying GraphQL request in ${backoffMs}ms`);
      await delay(backoffMs);
    }
  }

  throw lastError ?? new Error("GitHub GraphQL request failed");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildSearchQuery(repo: string, label?: string, since?: string, until?: string): string {
  let query = `repo:${repo} type:pr`;
  if (label) query += ` label:"${label}"`;
  if (since && until) query += ` created:${since}..${until}`;
  else if (since) query += ` created:>=${since}`;
  else if (until) query += ` created:<=${until}`;
  return query;
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repository format "${repo}". Expected "owner/repo".`);
  }
  return { owner, name };
}

function parseDateOnly(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  }
  return date;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

function normalizeDateRange(since?: string, until?: string): DateWindow {
  const normalizedSince = since ?? GITHUB_EPOCH_DATE;
  const normalizedUntil = until ?? formatDateOnly(new Date());
  const sinceDate = parseDateOnly(normalizedSince);
  const untilDate = parseDateOnly(normalizedUntil);

  if (sinceDate.getTime() > untilDate.getTime()) {
    throw new Error(
      `Invalid date range: since "${normalizedSince}" is after until "${normalizedUntil}".`,
    );
  }

  return { since: normalizedSince, until: normalizedUntil };
}

function splitWindow(window: DateWindow): [DateWindow, DateWindow] | null {
  const sinceDate = parseDateOnly(window.since);
  const untilDate = parseDateOnly(window.until);
  const totalDays = Math.floor((untilDate.getTime() - sinceDate.getTime()) / DAY_IN_MS);

  if (totalDays <= 0) return null;

  const leftDays = Math.floor(totalDays / 2);
  const leftUntil = addDays(window.since, leftDays);
  const rightSince = addDays(leftUntil, 1);

  return [
    { since: window.since, until: leftUntil },
    { since: rightSince, until: window.until },
  ];
}

function toPullRequest(node: PullRequestWithoutReviews, reviews: PRReview[]): PullRequest {
  return {
    ...node,
    reviews: { nodes: reviews },
  };
}

function uniqueReasons(reasons: string[]): string[] {
  const unique = Array.from(new Set(reasons.filter(Boolean)));
  if (unique.length <= 5) return unique;
  const omitted = unique.length - 4;
  return [...unique.slice(0, 4), `${omitted} additional partial fetch issue(s) omitted.`];
}

async function mapWithConcurrency<T, R>(
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

async function fetchWindowPullRequests(
  repo: string,
  label: string | undefined,
  window: DateWindow,
): Promise<FetchWindowResult> {
  log.info(
    `Searching PRs for ${repo} in window ${window.since}..${window.until}${label ? ` [label:${label}]` : ""}`,
  );
  const searchQuery = buildSearchQuery(repo, label, window.since, window.until);
  const firstPage = await ghGraphqlWithRetry<SearchResponse>(PR_SEARCH_QUERY, {
    searchQuery,
    first: SEARCH_PAGE_SIZE,
  });
  const issueCount = firstPage.search.issueCount;
  const partialReasons: string[] = [];
  const prs: PullRequestWithoutReviews[] = [...firstPage.search.nodes];
  let hasNextPage = firstPage.search.pageInfo.hasNextPage;
  let cursor = firstPage.search.pageInfo.endCursor;
  let pagesFetched = 1;
  log.info(
    `Window ${window.since}..${window.until}: fetched page 1 (${prs.length}/${issueCount} PR nodes loaded)`,
  );

  while (hasNextPage) {
    if (pagesFetched >= MAX_SEARCH_PAGES) {
      log.info(
        `Search limit reached for ${repo} in window ${window.since}..${window.until} at ${SEARCH_HARD_LIMIT} PRs`,
      );
      partialReasons.push(
        `GitHub Search limit reached for ${repo} (${window.since}..${window.until}); only first ${SEARCH_HARD_LIMIT} PRs were accessible in this window.`,
      );
      return {
        issueCount,
        prs,
        isComplete: false,
        partialReasons,
      };
    }

    const variables: Record<string, GraphqlVariable> = { searchQuery, first: SEARCH_PAGE_SIZE };
    if (cursor) variables.after = cursor;
    const page = await ghGraphqlWithRetry<SearchResponse>(PR_SEARCH_QUERY, variables);

    prs.push(...page.search.nodes);
    hasNextPage = page.search.pageInfo.hasNextPage;
    cursor = page.search.pageInfo.endCursor;
    pagesFetched++;
    log.info(
      `Window ${window.since}..${window.until}: fetched page ${pagesFetched} (${prs.length}/${issueCount} PR nodes loaded)`,
    );
  }

  log.info(`Completed window ${window.since}..${window.until}: ${prs.length} PR nodes fetched`);
  return {
    issueCount,
    prs,
    isComplete: true,
    partialReasons,
  };
}

async function fetchPullRequestReviews(repo: string, number: number): Promise<PRReview[]> {
  const { owner, name } = parseRepo(repo);
  let hasNextPage = true;
  let cursor: string | null = null;
  const reviews: PRReview[] = [];

  while (hasNextPage) {
    const variables: Record<string, GraphqlVariable> = {
      owner,
      name,
      number,
      first: REVIEW_PAGE_SIZE,
    };
    if (cursor) variables.after = cursor;

    const data = await ghGraphqlWithRetry<ReviewsResponse>(PR_REVIEWS_QUERY, variables);
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`Pull request ${repo}#${number} was not found while fetching reviews.`);
    }

    reviews.push(...pullRequest.reviews.nodes);
    hasNextPage = pullRequest.reviews.pageInfo.hasNextPage;
    cursor = pullRequest.reviews.pageInfo.endCursor;
  }

  return reviews;
}

async function fetchRepoPullRequests(
  repoInput: string,
  label: string | undefined,
  range: DateWindow,
): Promise<RepoFetchResult> {
  const repo = repoInput.trim();
  if (!repo) {
    return {
      prs: [],
      matchingPRs: 0,
      isComplete: true,
      partialReasons: [],
    };
  }

  log.info(`Starting repo fetch for ${repo} in range ${range.since}..${range.until}`);
  const windowsToFetch: DateWindow[] = [{ ...range }];
  const partialReasons: string[] = [];
  const dedupeSet = new Set<string>();
  const prNodes: PullRequestWithoutReviews[] = [];
  let matchingPRs = 0;
  let isComplete = true;

  while (windowsToFetch.length > 0) {
    const window = windowsToFetch.pop()!;
    log.info(`Processing window ${window.since}..${window.until} for ${repo}`);
    const windowResult = await fetchWindowPullRequests(repo, label, window);

    if (windowResult.issueCount > SEARCH_HARD_LIMIT) {
      const split = splitWindow(window);
      if (split) {
        const [left, right] = split;
        log.info(
          `Window ${window.since}..${window.until} has ${windowResult.issueCount} matches; splitting into ${left.since}..${left.until} and ${right.since}..${right.until}`,
        );
        windowsToFetch.push(right, left);
        continue;
      }

      isComplete = false;
      partialReasons.push(
        `A single-day window (${window.since}) in ${repo} has more than ${SEARCH_HARD_LIMIT} matching PRs and cannot be split further.`,
      );
    }

    matchingPRs += windowResult.issueCount;
    if (!windowResult.isComplete) isComplete = false;
    partialReasons.push(...windowResult.partialReasons);

    for (const pr of windowResult.prs) {
      const key = `${repo}#${pr.number}`;
      if (dedupeSet.has(key)) continue;
      dedupeSet.add(key);
      prNodes.push(pr);
    }

    log.info(
      `Repo ${repo} progress: ${prNodes.length} unique PR nodes collected (${matchingPRs} total matches reported by GitHub)`,
    );
  }

  log.info(
    `Fetching reviews for ${prNodes.length} PRs in ${repo} (concurrency=${REVIEW_FETCH_CONCURRENCY})`,
  );
  let completedReviewFetches = 0;
  const reviewedPRs = await mapWithConcurrency(
    prNodes,
    REVIEW_FETCH_CONCURRENCY,
    async (pr): Promise<{ pullRequest: PullRequest; isComplete: boolean; reason?: string }> => {
      try {
        const reviews = await fetchPullRequestReviews(repo, pr.number);
        completedReviewFetches++;
        if (
          prNodes.length <= 20 ||
          completedReviewFetches % 10 === 0 ||
          completedReviewFetches === prNodes.length
        ) {
          log.info(
            `Review fetch progress for ${repo}: ${completedReviewFetches}/${prNodes.length} PRs completed`,
          );
        }
        return { pullRequest: toPullRequest(pr, reviews), isComplete: true };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown review fetch error";
        completedReviewFetches++;
        log.warn(
          `Review fetch failed for ${repo}#${pr.number} (${completedReviewFetches}/${prNodes.length}): ${message}`,
        );
        return {
          pullRequest: toPullRequest(pr, []),
          isComplete: false,
          reason: `Failed to fetch complete reviews for ${repo}#${pr.number}: ${message}`,
        };
      }
    },
  );

  const completePRs: PullRequest[] = [];
  for (const item of reviewedPRs) {
    completePRs.push(item.pullRequest);
    if (!item.isComplete) {
      isComplete = false;
      if (item.reason) partialReasons.push(item.reason);
    }
  }

  log.info(
    `Completed repo fetch for ${repo}: analyzed ${completePRs.length} PRs, matching ${matchingPRs}, complete=${isComplete}`,
  );
  return {
    prs: completePRs,
    matchingPRs,
    isComplete,
    partialReasons: uniqueReasons(partialReasons),
  };
}

export async function fetchPullRequests(
  repos: string[],
  label?: string,
  since?: string,
  until?: string,
): Promise<PullRequestFetchResult> {
  const allPRs: PullRequest[] = [];
  const partialReasons: string[] = [];
  let matchingPRs = 0;
  let isComplete = true;
  const dateRange = normalizeDateRange(since, until);
  log.info(
    `Starting fetch across ${repos.length} repos in range ${dateRange.since}..${dateRange.until}${label ? ` [label:${label}]` : ""}`,
  );

  for (const repo of repos) {
    const repoResult = await fetchRepoPullRequests(repo, label, dateRange);
    allPRs.push(...repoResult.prs);
    matchingPRs += repoResult.matchingPRs;
    if (!repoResult.isComplete) isComplete = false;
    partialReasons.push(...repoResult.partialReasons);
  }

  log.info(
    `Finished fetch across repos: analyzed ${allPRs.length} PRs, matching ${matchingPRs}, complete=${isComplete}`,
  );
  return {
    prs: allPRs,
    matchingPRs,
    analyzedPRs: allPRs.length,
    isComplete,
    partialReasons: uniqueReasons(partialReasons),
  };
}
