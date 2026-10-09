import { execFile } from "node:child_process";
import { COMMENTS_PAGE_SIZE, type AppSuggestion, type PRReview } from "../shared/types.ts";
import { createLogger } from "./logger.ts";
import {
  batchAlias,
  fetchPullRequestsInBatches,
  pullRequestKey,
  readPullRequestBatch,
  type BatchEntry,
  type FetchedPullRequest,
  type GraphqlError,
  type PullRequestBatchResponse,
  type PullRequestRef,
} from "./pull-request-details.ts";
import { uniqueReasons, type PageInfo, type ReviewConnection } from "./review-pages.ts";

const log = createLogger("fetch");

const SEARCH_PAGE_SIZE = 100;
const REVIEW_PAGE_SIZE = 100;
const INLINE_REVIEW_PAGE_SIZE = 50;
const SEARCH_HARD_LIMIT = 1000;
const MAX_SEARCH_PAGES = SEARCH_HARD_LIMIT / SEARCH_PAGE_SIZE;
// Measured on nodejs/node: one call takes about 1.6 s for 50 PRs and 2.4 s for 100 (1 point
// each), and 664 cold PRs took the same wall time at both sizes. With the timeline and
// comment fields planned for the fragment, 100 PRs take 7 to 8 s (3 points), close to
// GitHub's 10 s query timeout, while 50 take about 4 s (2 points). 50 leaves that headroom.
const PR_BATCH_SIZE = 50;
const FETCH_CONCURRENCY = 5;
const GRAPHQL_MAX_ATTEMPTS = 3;
const GITHUB_EPOCH_DATE = "2008-01-01";
const DAY_IN_MS = 24 * 60 * 60 * 1000;

// The review fields every query that returns reviews selects.
const REVIEW_FIELDS = `
fragment ReviewFields on PullRequestReview {
  author { login __typename }
  state
  submittedAt
  body
}`;

// The PR fields every query that returns pull request data selects. A new field goes here,
// in PullRequest (shared/types.ts) and in pullRequestSchema (pull-requests.ts), with a
// CACHE_VERSION bump.
const PULL_REQUEST_FIELDS = `
fragment PullRequestFields on PullRequest {
  number
  title
  state
  url
  createdAt
  updatedAt
  mergedAt
  closedAt
  isDraft
  author { login }
  timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], first: 1) {
    nodes {
      ... on ReadyForReviewEvent { createdAt }
    }
  }
  reviews(first: ${INLINE_REVIEW_PAGE_SIZE}) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes { ...ReviewFields }
  }
  comments(first: ${COMMENTS_PAGE_SIZE}) {
    nodes {
      author { login __typename }
      createdAt
    }
  }
}
${REVIEW_FIELDS}`;

// Lists PRs without their data: updatedAt tells which cached PRs are still current.
const PR_LISTING_QUERY = `
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
        updatedAt
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
        nodes { ...ReviewFields }
      }
    }
  }
}
${REVIEW_FIELDS}`;

// One aliased pullRequest field per number, so a single call fetches a whole batch.
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

const REPOSITORY_SEARCH_QUERY = `
query($searchQuery: String!, $first: Int!) {
  search(query: $searchQuery, type: REPOSITORY, first: $first) {
    nodes {
      ... on Repository {
        nameWithOwner
        description
        isPrivate
      }
    }
  }
}`;

const VIEWER_REPOSITORIES_QUERY = `
query($first: Int!) {
  viewer {
    repositories(
      first: $first
      orderBy: { field: PUSHED_AT, direction: DESC }
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
    ) {
      nodes {
        nameWithOwner
        description
        isPrivate
      }
    }
  }
}`;

const LABELS_QUERY = `
query($owner: String!, $name: String!, $first: Int!, $labelQuery: String) {
  repository(owner: $owner, name: $name) {
    labels(first: $first, query: $labelQuery, orderBy: { field: NAME, direction: ASC }) {
      nodes {
        name
        color
        description
      }
    }
  }
}`;

const USER_SEARCH_QUERY = `
query($searchQuery: String!, $first: Int!) {
  search(query: $searchQuery, type: USER, first: $first) {
    nodes {
      ... on User {
        login
        name
      }
    }
  }
}`;

interface ListedPullRequestNode {
  number: number;
  updatedAt: string;
}

interface ListingResponse {
  search: {
    issueCount: number;
    pageInfo: PageInfo;
    nodes: ListedPullRequestNode[];
  };
}

interface ReviewsResponse {
  repository: {
    pullRequest: {
      reviews: ReviewConnection;
    } | null;
  } | null;
}

interface RepositorySuggestionNode {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
}

interface RepositorySearchResponse {
  search: {
    nodes: Array<RepositorySuggestionNode | null>;
  };
}

interface ViewerRepositoriesResponse {
  viewer: {
    repositories: {
      nodes: Array<RepositorySuggestionNode | null>;
    };
  };
}

interface LabelsResponse {
  repository: {
    labels: {
      nodes: Array<{
        name: string;
        color: string;
        description: string | null;
      } | null>;
    };
  } | null;
}

interface UserSearchResponse {
  search: {
    nodes: Array<{
      login: string;
      name: string | null;
    } | null>;
  };
}

interface DateWindow {
  since: string;
  until: string;
}

// "split": the window matches more PRs than Search returns and can be halved.
type ListWindowResult =
  | { kind: "split"; issueCount: number; halves: [DateWindow, DateWindow] }
  | {
      kind: "listed";
      issueCount: number;
      prs: ListedPullRequestNode[];
      isComplete: boolean;
      partialReasons: string[];
    };

export interface ListedPullRequest extends PullRequestRef {
  updatedAt: string;
}

// The PRs a search matches, without their data. isComplete and partialReasons cover the
// search only, such as the 1000-result limit.
export interface PullRequestListing {
  prs: ListedPullRequest[];
  matchingPRs: number;
  isComplete: boolean;
  partialReasons: string[];
}

type GraphqlVariable = boolean | number | string | null | undefined;

interface GraphqlResponse<T> {
  data: T;
  errors?: GraphqlError[];
}

const GH_NOT_FOUND_MESSAGE = "GitHub CLI (gh) not found. Install from https://cli.github.com";

function buildGraphqlArgs(query: string, variables: Record<string, GraphqlVariable>): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];

  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      args.push("-F", `${key}=${value}`);
    } else {
      args.push("-f", `${key}=${String(value)}`);
    }
  }
  return args;
}

function ghGraphql<T>(query: string, variables: Record<string, GraphqlVariable> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const args = buildGraphqlArgs(query, variables);

    execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message);
        if (err.code === "ENOENT") {
          reject(new Error(GH_NOT_FOUND_MESSAGE));
        } else {
          reject(new Error(message));
        }
        return;
      }

      try {
        const response: GraphqlResponse<T> = JSON.parse(String(stdout));
        if (response.errors?.length) {
          reject(new Error(response.errors.map((e) => e.message).join(", ")));
          return;
        }
        resolve(response.data);
      } catch {
        reject(new Error("Failed to parse GitHub API response"));
      }
    });
  });
}

// Unlike ghGraphql, resolves with partial data and its errors. gh exits non-zero when the
// response has errors but still prints it, so stdout is parsed either way. Rejects only when
// there is no data at all.
function ghGraphqlPartial<T>(
  query: string,
  variables: Record<string, GraphqlVariable> = {},
): Promise<{ data: T | null; errors?: GraphqlError[] }> {
  return new Promise((resolve, reject) => {
    const args = buildGraphqlArgs(query, variables);

    execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") {
        reject(new Error(GH_NOT_FOUND_MESSAGE));
        return;
      }

      let response: GraphqlResponse<T | null> | null = null;
      try {
        response = JSON.parse(String(stdout));
      } catch {
        // Handled below with gh's own error message.
      }
      if (response?.data) {
        resolve(response);
        return;
      }
      const messages = response?.errors?.map((e) => e.message).join(", ");
      reject(
        new Error(
          messages || (err ? String(stderr || err.message) : "Failed to parse GitHub API response"),
        ),
      );
    });
  });
}

async function withGraphqlRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < GRAPHQL_MAX_ATTEMPTS) {
    try {
      return await run();
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

function ghGraphqlWithRetry<T>(
  query: string,
  variables: Record<string, GraphqlVariable> = {},
): Promise<T> {
  return withGraphqlRetry(() => ghGraphql<T>(query, variables));
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

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesSuggestionSeed(value: string, query: string): boolean {
  return query === "" || value.toLowerCase().includes(query.toLowerCase());
}

function addUniqueSuggestion(
  suggestions: AppSuggestion[],
  seen: Set<string>,
  suggestion: AppSuggestion,
) {
  const key = suggestion.value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  suggestions.push(suggestion);
}

function uniqueSuggestions(suggestions: AppSuggestion[], limit: number): AppSuggestion[] {
  const seen = new Set<string>();
  const unique: AppSuggestion[] = [];
  for (const suggestion of suggestions) {
    addUniqueSuggestion(unique, seen, suggestion);
    if (unique.length >= limit) break;
  }
  return unique;
}

function toRepositorySuggestion(node: RepositorySuggestionNode): AppSuggestion {
  return {
    value: node.nameWithOwner,
    detail: node.description ?? (node.isPrivate ? "Private repository" : "Repository"),
    isPrivate: node.isPrivate,
  };
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

export async function fetchRepositorySuggestions(
  query: string,
  defaultRepos: string[] = [],
): Promise<AppSuggestion[]> {
  const trimmed = query.trim();
  const seedSuggestions = defaultRepos
    .filter((repo) => matchesSuggestionSeed(repo, trimmed))
    .map((repo) => ({ value: repo, detail: "Default repository" }));

  try {
    if (trimmed) {
      const data = await ghGraphqlWithRetry<RepositorySearchResponse>(REPOSITORY_SEARCH_QUERY, {
        searchQuery: `${trimmed} in:name fork:true`,
        first: 12,
      });
      const githubSuggestions = data.search.nodes
        .filter((node): node is RepositorySuggestionNode => node !== null)
        .map(toRepositorySuggestion);

      return uniqueSuggestions([...seedSuggestions, ...githubSuggestions], 12);
    }

    const data = await ghGraphqlWithRetry<ViewerRepositoriesResponse>(VIEWER_REPOSITORIES_QUERY, {
      first: 12,
    });
    const githubSuggestions = data.viewer.repositories.nodes
      .filter((node): node is RepositorySuggestionNode => node !== null)
      .map(toRepositorySuggestion);

    return uniqueSuggestions([...seedSuggestions, ...githubSuggestions], 12);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown repository suggestion error";
    log.warn(`Repository suggestions failed: ${message}`);
    return uniqueSuggestions(seedSuggestions, 12);
  }
}

export async function fetchLabelSuggestions(
  repoInput: string,
  query: string,
  defaultLabel?: string,
): Promise<AppSuggestion[]> {
  const trimmed = query.trim();
  const seedSuggestions =
    defaultLabel && matchesSuggestionSeed(defaultLabel, trimmed)
      ? [{ value: defaultLabel, detail: "Default label" }]
      : [];
  const suggestions: AppSuggestion[] = [...seedSuggestions];
  const repos = splitList(repoInput).slice(0, 5);

  for (const repo of repos) {
    let parsed: { owner: string; name: string };
    try {
      parsed = parseRepo(repo);
    } catch {
      continue;
    }

    try {
      const data = await ghGraphqlWithRetry<LabelsResponse>(LABELS_QUERY, {
        owner: parsed.owner,
        name: parsed.name,
        first: 20,
        labelQuery: trimmed || undefined,
      });

      for (const label of data.repository?.labels.nodes ?? []) {
        if (!label) continue;
        suggestions.push({
          value: label.name,
          detail:
            repos.length > 1
              ? `${repo}${label.description ? ` - ${label.description}` : ""}`
              : (label.description ?? undefined),
          color: label.color,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown label suggestion error";
      log.warn(`Label suggestions failed for ${repo}: ${message}`);
    }
  }

  return uniqueSuggestions(suggestions, 20);
}

export async function fetchUserSuggestions(
  query: string,
  defaultUsers: string[] = [],
): Promise<AppSuggestion[]> {
  const trimmed = query.trim();
  const seedSuggestions = defaultUsers
    .filter((user) => matchesSuggestionSeed(user, trimmed))
    .map((user) => ({ value: user, detail: "Default team member" }));

  if (trimmed.length < 2) {
    return uniqueSuggestions(seedSuggestions, 12);
  }

  try {
    const data = await ghGraphqlWithRetry<UserSearchResponse>(USER_SEARCH_QUERY, {
      searchQuery: `${trimmed} in:login in:name type:user`,
      first: 12,
    });
    const githubSuggestions = data.search.nodes
      .filter((node): node is { login: string; name: string | null } => node !== null)
      .map((node) => ({ value: node.login, detail: node.name ?? "GitHub user" }));

    return uniqueSuggestions([...seedSuggestions, ...githubSuggestions], 12);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown user suggestion error";
    log.warn(`User suggestions failed: ${message}`);
    return uniqueSuggestions(seedSuggestions, 12);
  }
}

async function listWindowPullRequests(
  repo: string,
  label: string | undefined,
  window: DateWindow,
): Promise<ListWindowResult> {
  log.info(
    `Listing PRs for ${repo} in window ${window.since}..${window.until}${label ? ` [label:${label}]` : ""}`,
  );
  const searchQuery = buildSearchQuery(repo, label, window.since, window.until);
  const firstPage = await ghGraphqlWithRetry<ListingResponse>(PR_LISTING_QUERY, {
    searchQuery,
    first: SEARCH_PAGE_SIZE,
  });
  const issueCount = firstPage.search.issueCount;
  const partialReasons: string[] = [];
  let isComplete = true;

  if (issueCount > SEARCH_HARD_LIMIT) {
    // Stop after page 1: the caller lists each half instead.
    const halves = splitWindow(window);
    if (halves) return { kind: "split", issueCount, halves };

    isComplete = false;
    partialReasons.push(
      `A single-day window (${window.since}) in ${repo} has more than ${SEARCH_HARD_LIMIT} matching PRs and cannot be split further.`,
    );
  }

  const prs: ListedPullRequestNode[] = [...firstPage.search.nodes];
  let hasNextPage = firstPage.search.pageInfo.hasNextPage;
  let cursor = firstPage.search.pageInfo.endCursor;
  let pagesFetched = 1;
  log.info(
    `Window ${window.since}..${window.until}: listed page 1 (${prs.length}/${issueCount} PRs)`,
  );

  while (hasNextPage) {
    if (pagesFetched >= MAX_SEARCH_PAGES) {
      log.info(
        `Search limit reached for ${repo} in window ${window.since}..${window.until} at ${SEARCH_HARD_LIMIT} PRs`,
      );
      partialReasons.push(
        `GitHub Search limit reached for ${repo} (${window.since}..${window.until}); only first ${SEARCH_HARD_LIMIT} PRs were accessible in this window.`,
      );
      return { kind: "listed", issueCount, prs, isComplete: false, partialReasons };
    }

    const variables: Record<string, GraphqlVariable> = { searchQuery, first: SEARCH_PAGE_SIZE };
    if (cursor) variables.after = cursor;
    const page = await ghGraphqlWithRetry<ListingResponse>(PR_LISTING_QUERY, variables);

    prs.push(...page.search.nodes);
    hasNextPage = page.search.pageInfo.hasNextPage;
    cursor = page.search.pageInfo.endCursor;
    pagesFetched++;
    log.info(
      `Window ${window.since}..${window.until}: listed page ${pagesFetched} (${prs.length}/${issueCount} PRs)`,
    );
  }

  log.info(`Completed window ${window.since}..${window.until}: ${prs.length} PRs listed`);
  return { kind: "listed", issueCount, prs, isComplete, partialReasons };
}

async function listRepoPullRequests(
  repo: string,
  label: string | undefined,
  range: DateWindow,
): Promise<PullRequestListing> {
  log.info(`Starting repo listing for ${repo} in range ${range.since}..${range.until}`);
  const windowsToList: DateWindow[] = [{ ...range }];
  const partialReasons: string[] = [];
  const seen = new Set<number>();
  const prs: ListedPullRequest[] = [];
  let matchingPRs = 0;
  let isComplete = true;

  while (windowsToList.length > 0) {
    const window = windowsToList.pop()!;
    const windowResult = await listWindowPullRequests(repo, label, window);

    if (windowResult.kind === "split") {
      const [left, right] = windowResult.halves;
      log.info(
        `Window ${window.since}..${window.until} has ${windowResult.issueCount} matches; splitting into ${left.since}..${left.until} and ${right.since}..${right.until}`,
      );
      windowsToList.push(right, left);
      continue;
    }

    matchingPRs += windowResult.issueCount;
    if (!windowResult.isComplete) isComplete = false;
    partialReasons.push(...windowResult.partialReasons);

    for (const pr of windowResult.prs) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      prs.push({ repo, number: pr.number, updatedAt: pr.updatedAt });
    }
  }

  log.info(
    `Completed repo listing for ${repo}: ${prs.length} PRs listed, matching ${matchingPRs}, complete=${isComplete}`,
  );
  return { prs, matchingPRs, isComplete, partialReasons };
}

async function fetchPullRequestReviews(
  repo: string,
  number: number,
  after: string | null = null,
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

async function fetchPullRequestBatch(repo: string, numbers: number[]): Promise<BatchEntry[]> {
  const { owner, name } = parseRepo(repo);
  const response = await withGraphqlRetry(() =>
    ghGraphqlPartial<NonNullable<PullRequestBatchResponse["data"]>>(
      buildPullRequestBatchQuery(numbers),
      { owner, name },
    ),
  );
  return readPullRequestBatch({ repo, numbers, response });
}

// Lists the PRs created in the range. Oversized windows are split to get past the
// 1000-result Search limit. Repos are expected normalized (see normalizeRepos).
export async function listPullRequests({
  repos,
  label,
  since,
  until,
}: {
  repos: string[];
  label?: string;
  since?: string;
  until?: string;
}): Promise<PullRequestListing> {
  const dateRange = normalizeDateRange(since, until);
  log.info(
    `Starting listing across ${repos.length} repos in range ${dateRange.since}..${dateRange.until}${label ? ` [label:${label}]` : ""}`,
  );
  const prs: ListedPullRequest[] = [];
  const partialReasons: string[] = [];
  let matchingPRs = 0;
  let isComplete = true;

  for (const repo of repos) {
    const repoListing = await listRepoPullRequests(repo, label, dateRange);
    prs.push(...repoListing.prs);
    matchingPRs += repoListing.matchingPRs;
    if (!repoListing.isComplete) isComplete = false;
    partialReasons.push(...repoListing.partialReasons);
  }

  return { prs, matchingPRs, isComplete, partialReasons: uniqueReasons(partialReasons) };
}

// Fetches each PR's data and reviews in batches, one repo at a time. The map is keyed by
// pullRequestKey and has one entry per requested PR.
export async function fetchPullRequestDetails(
  refs: PullRequestRef[],
): Promise<Map<string, FetchedPullRequest>> {
  const numbersByRepo = new Map<string, number[]>();
  for (const { repo, number } of refs) {
    const numbers = numbersByRepo.get(repo) ?? [];
    numbers.push(number);
    numbersByRepo.set(repo, numbers);
  }

  const fetched = new Map<string, FetchedPullRequest>();
  for (const [repo, numbers] of numbersByRepo) {
    const results = await fetchPullRequestsInBatches({
      repo,
      numbers,
      batchSize: PR_BATCH_SIZE,
      concurrency: FETCH_CONCURRENCY,
      fetchBatch: (batch) => fetchPullRequestBatch(repo, batch),
      fetchContinuation: (pr) =>
        fetchPullRequestReviews(repo, pr.number, pr.reviews.pageInfo.endCursor),
    });
    numbers.forEach((number, index) => {
      fetched.set(pullRequestKey({ repo, number }), results[index]);
    });
  }
  return fetched;
}
