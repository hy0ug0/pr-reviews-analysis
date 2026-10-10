import { z } from "zod";
import { GITHUB_EPOCH_DATE, todayUtc } from "../shared/schemas.ts";
import type { AppSuggestion } from "../shared/types.ts";
import type { GitHubRun } from "./github-run.ts";
import { githubToken, type TokenProvider } from "./github-token.ts";
import { uniqueReasons } from "./lib/partial-reasons.ts";
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
import {
  describeSchemaError,
  PULL_REQUEST_FIELDS,
  REVIEW_FIELDS,
  reviewConnectionSchema,
  type PageInfo,
  type PRReview,
} from "./pull-request-model.ts";

const log = createLogger("fetch");

const SEARCH_PAGE_SIZE = 100;
const REVIEW_PAGE_SIZE = 100;
const SEARCH_HARD_LIMIT = 1000;
const MAX_SEARCH_PAGES = SEARCH_HARD_LIMIT / SEARCH_PAGE_SIZE;
// GitHub stops a query at about 10 s and answers 502 or 504. Without review request events,
// 50 PRs took about 4 s (2 points). With them, 50 of the busiest PRs of nodejs/node and
// microsoft/vscode took 10 to 11 s and timed out, while 25 take 3 to 7.5 s (1 point). The
// cost per PR is the same at both sizes, 1 point per 25 PRs, so 25 only adds calls.
const PR_BATCH_SIZE = 25;
const FETCH_CONCURRENCY = 5;
const GRAPHQL_MAX_ATTEMPTS = 3;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

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

export interface ListingResponse {
  search: {
    issueCount: number;
    pageInfo: PageInfo;
    nodes: ListedPullRequestNode[];
  };
}

// `reviews` is parsed with reviewConnectionSchema before use.
interface ReviewsResponse {
  repository: {
    pullRequest: {
      reviews: unknown;
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
type GraphqlVariables = Record<string, GraphqlVariable>;

export interface GraphqlResponse<T> {
  data: T;
  errors?: GraphqlError[];
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_DEADLINE_MS = 30_000;
// A secondary rate limit answers without a reset time; GitHub's docs say to wait a minute.
const SECONDARY_RATE_LIMIT_WAIT_MS = 60_000;
// Longer waits fail at once: the user is better told when the limit resets.
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const TOKEN_REJECTED_MESSAGE = "GitHub rejected the token. Run: gh auth login";
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504]);

// What GitHub sends back, before `data` is trusted as the query's type.
const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        type: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  fetch?: FetchLike;
  tokenProvider?: TokenProvider;
  sleep?: (ms: number) => Promise<void>;
  // Epoch milliseconds, for rate-limit reset headers.
  now?: () => number;
  deadlineMs?: number;
}

export interface GitHubClient {
  // Resolves with the query's data; any GraphQL error rejects.
  query<T>(query: string, variables?: GraphqlVariables, run?: GitHubRun): Promise<T>;
  // Resolves with whatever data came back and its errors, as a batch query can answer
  // some aliases and fail others. Rejects only when there is no data at all.
  queryPartial<T>(
    query: string,
    variables: GraphqlVariables,
    run?: GitHubRun,
  ): Promise<GraphqlResponse<T>>;
}

// What one HTTP attempt came to. "retry" is a transient failure: a network error, the
// deadline, a 5xx, a rate limit (with the wait GitHub asks for) or a GraphQL timeout.
type AttemptOutcome<T> =
  | { kind: "ok"; response: GraphqlResponse<T> }
  | { kind: "retry"; error: Error; waitMs?: number }
  | { kind: "unauthorized" }
  | { kind: "fail"; error: Error };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Unset variables are left out, so GraphQL sees them as null; numbers and booleans stay typed.
function buildBody(query: string, variables: GraphqlVariables): string {
  const defined = Object.fromEntries(
    Object.entries(variables).filter(([, value]) => value !== undefined && value !== null),
  );
  return JSON.stringify({ query, variables: defined });
}

// 429 always is; 403 only with a rate-limit header, as it is also GitHub's permission error.
function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return (
    status === 403 && (headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0")
  );
}

// Retry-After is either a number of seconds or an HTTP date (RFC 9110).
function retryAfterMs(value: string, nowMs: number): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

function rateLimitWaitMs(headers: Headers, nowMs: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const waitMs = retryAfterMs(retryAfter, nowMs);
    if (waitMs !== null) return waitMs;
  }
  // Every response carries x-ratelimit-reset, so on its own it says nothing about a limit:
  // a secondary limit with remaining > 0 would turn a one-minute wait into a failure.
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - nowMs);
  }
  return SECONDARY_RATE_LIMIT_WAIT_MS;
}

function rateLimitOutcome<T>(headers: Headers, nowMs: number): AttemptOutcome<T> {
  const waitMs = rateLimitWaitMs(headers, nowMs);
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
    return {
      kind: "fail",
      error: new Error(`GitHub rate limit reached, resets at ${formatLocalTime(nowMs + waitMs)}`),
    };
  }
  return { kind: "retry", error: new Error("GitHub rate limit reached"), waitMs };
}

// GitHub reports a query it gave up on as an untyped error in a 200 response: "Something
// went wrong while executing your query. This may be the result of a timeout, ..." or "Query
// timed out". The phrase has to end the clause, so a field or argument named `timeout` in a
// validation message ("Field 'timeout' doesn't exist") does not count.
const TIMEOUT_REPORT = /\btimed out\b|\btimeout(?=[.,;:!]|$)/i;

// Typed errors (NOT_FOUND, FORBIDDEN, ...) are never transient, except RATE_LIMITED.
function isTransientGraphqlError(error: GraphqlError): boolean {
  if (error.type !== undefined) return error.type === "RATE_LIMITED";
  return TIMEOUT_REPORT.test(error.message);
}

// Retried only when every error is transient: a mixed answer has a real failure in it.
function graphqlErrorsOutcome<T>(
  errors: GraphqlError[],
  headers: Headers,
  nowMs: number,
): AttemptOutcome<T> {
  const message = errors.map((error) => error.message).join(", ");
  if (!errors.every(isTransientGraphqlError)) return { kind: "fail", error: new Error(message) };
  if (errors.some((error) => error.type === "RATE_LIMITED")) {
    return rateLimitOutcome(headers, nowMs);
  }
  return { kind: "retry", error: new Error(message) };
}

// The body's `message`, as GitHub's HTTP errors carry one. Never the token.
function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      detail = typeof parsed.message === "string" ? parsed.message : "";
    }
  } catch {
    // Not JSON; the status is enough.
  }
  return `GitHub responded with HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

// A 401 or a header-signalled rate limit never gets here: attempt() answers those from the
// headers alone. A RATE_LIMITED GraphQL error does, since it is in the body.
function classifyResponse<T>({
  status,
  headers,
  body,
  nowMs,
  acceptPartial,
}: {
  status: number;
  headers: Headers;
  body: string;
  nowMs: number;
  acceptPartial: boolean;
}): AttemptOutcome<T> {
  if (TRANSIENT_HTTP_STATUSES.has(status)) {
    return { kind: "retry", error: new Error(describeHttpError(status, body)) };
  }
  if (status < 200 || status >= 300) {
    return { kind: "fail", error: new Error(describeHttpError(status, body)) };
  }

  let envelope: z.infer<typeof graphqlEnvelopeSchema>;
  try {
    envelope = graphqlEnvelopeSchema.parse(JSON.parse(body));
  } catch {
    return { kind: "fail", error: new Error("Failed to parse GitHub API response") };
  }

  const errors = envelope.errors ?? [];
  if (envelope.data !== null && envelope.data !== undefined) {
    // The caller's type is a promise about the query, not something a schema can check here.
    const data = envelope.data as T;
    if (errors.length === 0) return { kind: "ok", response: { data } };
    if (acceptPartial) return { kind: "ok", response: { data, errors } };
  }
  if (errors.length === 0) {
    return { kind: "fail", error: new Error("GitHub API response has no data") };
  }
  return graphqlErrorsOutcome(errors, headers, nowMs);
}

// Defence in depth: a fetch error can quote the request headers, token included.
function redactToken(message: string, token: string): string {
  return message.split(token).join("***");
}

function redactOutcome<T>(outcome: AttemptOutcome<T>, token: string): AttemptOutcome<T> {
  if (outcome.kind !== "retry" && outcome.kind !== "fail") return outcome;
  return { ...outcome, error: new Error(redactToken(outcome.error.message, token)) };
}

// One POST to the GraphQL endpoint, with `fetch`. The suggestion endpoints pass no run.
// Tests inject a fake fetch, token, clock and sleep, so no test needs the network or timers.
export function createGitHubClient({
  fetch: fetchImpl = fetch,
  tokenProvider = githubToken,
  sleep = delay,
  now = Date.now,
  deadlineMs = REQUEST_DEADLINE_MS,
}: GitHubClientOptions = {}): GitHubClient {
  // Every HTTP attempt goes through here, so a run counts each one, retries included.
  async function attempt<T>(
    body: string,
    token: string,
    run: GitHubRun | undefined,
    acceptPartial: boolean,
  ): Promise<AttemptOutcome<T>> {
    if (run) run.requests++;
    // One deadline for the whole exchange, body read included.
    const signal = AbortSignal.timeout(deadlineMs);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "pr-reviews-analysis",
        },
        body,
        signal,
      });
      // Decided on the headers alone, so a body that stalls or resets cannot turn a 401
      // into a transient retry, or a known reset time into blind backoff.
      if (response.status === 401) {
        response.body?.cancel().catch(() => {});
        return { kind: "unauthorized" };
      }
      if (isRateLimited(response.status, response.headers)) {
        response.body?.cancel().catch(() => {});
        return redactOutcome(rateLimitOutcome(response.headers, now()), token);
      }
      text = await response.text();
    } catch (error: unknown) {
      const message = signal.aborted
        ? `GitHub request timed out after ${deadlineMs / 1000} s`
        : `GitHub request failed: ${describeError(error)}`;
      return redactOutcome({ kind: "retry", error: new Error(message) }, token);
    }
    return redactOutcome(
      classifyResponse({
        status: response.status,
        headers: response.headers,
        body: text,
        nowMs: now(),
        acceptPartial,
      }),
      token,
    );
  }

  // Up to GRAPHQL_MAX_ATTEMPTS attempts on transient failures. A 401 refreshes the token
  // and tries once more without using up an attempt; a second 401 means the login is bad.
  async function request<T>(
    query: string,
    variables: GraphqlVariables,
    run: GitHubRun | undefined,
    acceptPartial: boolean,
  ): Promise<GraphqlResponse<T>> {
    const body = buildBody(query, variables);
    let token = await tokenProvider.get();
    let tokenRefreshed = false;
    let failures = 0;

    while (true) {
      const outcome = await attempt<T>(body, token, run, acceptPartial);
      switch (outcome.kind) {
        case "ok":
          return outcome.response;
        case "fail":
          throw outcome.error;
        case "unauthorized":
          if (tokenRefreshed) throw new Error(TOKEN_REJECTED_MESSAGE);
          log.warn("GitHub rejected the token; reading it again from gh");
          tokenRefreshed = true;
          token = await tokenProvider.refresh();
          break;
        case "retry": {
          failures++;
          log.warn(
            `GraphQL request failed (attempt ${failures}/${GRAPHQL_MAX_ATTEMPTS}): ${outcome.error.message}`,
          );
          if (failures >= GRAPHQL_MAX_ATTEMPTS) throw outcome.error;
          if (outcome.waitMs === undefined) {
            const backoffMs = 200 * 2 ** (failures - 1);
            log.warn(`Retrying GraphQL request in ${backoffMs}ms`);
            await sleep(backoffMs);
          } else {
            log.warn(`Waiting ${Math.ceil(outcome.waitMs / 1000)} s for the GitHub rate limit`);
            // The run shows the wait in its progress; plain backoff is too short to mention.
            const endWait = run?.rateLimited(now() + outcome.waitMs);
            try {
              await sleep(outcome.waitMs);
            } finally {
              endWait?.();
            }
          }
          break;
        }
        default: {
          const _exhaustive: never = outcome;
          throw new Error(`Unexpected outcome ${String(_exhaustive)}`);
        }
      }
    }
  }

  return {
    async query<T>(query: string, variables: GraphqlVariables = {}, run?: GitHubRun) {
      const response = await request<T>(query, variables, run, false);
      return response.data;
    },
    queryPartial: <T>(query: string, variables: GraphqlVariables, run?: GitHubRun) =>
      request<T>(query, variables, run, true),
  };
}

const github = createGitHubClient();

function buildSearchQuery(repo: string, label?: string, since?: string, until?: string): string {
  let query = `repo:${repo} type:pr`;
  if (label) query += ` label:"${label}"`;
  if (since && until) query += ` created:${since}..${until}`;
  else if (since) query += ` created:>=${since}`;
  else if (until) query += ` created:<=${until}`;
  return query;
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
  const normalizedUntil = until ?? todayUtc();
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
      const data = await github.query<RepositorySearchResponse>(REPOSITORY_SEARCH_QUERY, {
        searchQuery: `${trimmed} in:name fork:true`,
        first: 12,
      });
      const githubSuggestions = data.search.nodes
        .filter((node): node is RepositorySuggestionNode => node !== null)
        .map(toRepositorySuggestion);

      return uniqueSuggestions([...seedSuggestions, ...githubSuggestions], 12);
    }

    const data = await github.query<ViewerRepositoriesResponse>(VIEWER_REPOSITORIES_QUERY, {
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
  repoList: readonly string[],
  query: string,
  defaultLabel?: string,
): Promise<AppSuggestion[]> {
  const trimmed = query.trim();
  const seedSuggestions =
    defaultLabel && matchesSuggestionSeed(defaultLabel, trimmed)
      ? [{ value: defaultLabel, detail: "Default label" }]
      : [];
  const suggestions: AppSuggestion[] = [...seedSuggestions];
  const repos = repoList.slice(0, 5);

  for (const repo of repos) {
    let parsed: { owner: string; name: string };
    try {
      parsed = parseRepo(repo);
    } catch {
      continue;
    }

    try {
      const data = await github.query<LabelsResponse>(LABELS_QUERY, {
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
    const data = await github.query<UserSearchResponse>(USER_SEARCH_QUERY, {
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

// One page of a PR search, after `after` (null for the first page). listPullRequests passes
// the GitHub call; tests pass a fake.
export type SearchPullRequestPage = (
  searchQuery: string,
  after: string | null,
) => Promise<ListingResponse>;

// Called after each page kept in a window, with the PRs listed in it so far.
type OnWindowPage = (page: { listed: number; issueCount: number; page: number }) => void;

async function listWindowPullRequests(
  repo: string,
  label: string | undefined,
  window: DateWindow,
  searchPage: SearchPullRequestPage,
  onPage: OnWindowPage,
): Promise<ListWindowResult> {
  log.info(
    `Listing PRs for ${repo} in window ${window.since}..${window.until}${label ? ` [label:${label}]` : ""}`,
  );
  const searchQuery = buildSearchQuery(repo, label, window.since, window.until);
  const firstPage = await searchPage(searchQuery, null);
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
  onPage({ listed: prs.length, issueCount, page: pagesFetched });

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

    const page = await searchPage(searchQuery, cursor);

    prs.push(...page.search.nodes);
    hasNextPage = page.search.pageInfo.hasNextPage;
    cursor = page.search.pageInfo.endCursor;
    pagesFetched++;
    log.info(
      `Window ${window.since}..${window.until}: listed page ${pagesFetched} (${prs.length}/${issueCount} PRs)`,
    );
    onPage({ listed: prs.length, issueCount, page: pagesFetched });
  }

  log.info(`Completed window ${window.since}..${window.until}: ${prs.length} PRs listed`);
  return { kind: "listed", issueCount, prs, isComplete, partialReasons };
}

// How far one repo's listing is. `matching` is the whole range's count, from the first page
// of the first window; null before that page. windowsTotal grows when a window is split.
export interface RepoListingProgress {
  listed: number;
  matching: number | null;
  page: number;
  windowsDone: number;
  windowsTotal: number;
}

// Lists one repo's PRs in the range, splitting windows past the 1000-result Search limit.
// onProgress gets a snapshot before the first page and after each page.
export async function listRepoPullRequests({
  repo,
  label,
  range,
  searchPage,
  onProgress = () => {},
}: {
  repo: string;
  label: string | undefined;
  range: DateWindow;
  searchPage: SearchPullRequestPage;
  onProgress?: (progress: RepoListingProgress) => void;
}): Promise<PullRequestListing> {
  log.info(`Starting repo listing for ${repo} in range ${range.since}..${range.until}`);
  const windowsToList: DateWindow[] = [{ ...range }];
  const partialReasons: string[] = [];
  const seen = new Set<number>();
  const prs: ListedPullRequest[] = [];
  let matchingPRs = 0;
  let isComplete = true;
  let rangeMatching: number | null = null;
  let windowsDone = 0;
  // The window being listed counts too, so the total includes it.
  const windowsTotal = () => windowsDone + windowsToList.length + 1;
  onProgress({ listed: 0, matching: null, page: 0, windowsDone, windowsTotal: 1 });

  while (windowsToList.length > 0) {
    const window = windowsToList.pop()!;
    const windowResult = await listWindowPullRequests(
      repo,
      label,
      window,
      searchPage,
      ({ listed, issueCount, page }) => {
        rangeMatching ??= issueCount;
        onProgress({
          listed: seen.size + listed,
          matching: rangeMatching,
          page,
          windowsDone,
          windowsTotal: windowsTotal(),
        });
      },
    );
    rangeMatching ??= windowResult.issueCount;

    if (windowResult.kind === "split") {
      const [left, right] = windowResult.halves;
      log.info(
        `Window ${window.since}..${window.until} has ${windowResult.issueCount} matches; splitting into ${left.since}..${left.until} and ${right.since}..${right.until}`,
      );
      windowsToList.push(right, left);
      onProgress({
        listed: seen.size,
        matching: rangeMatching,
        page: 0,
        windowsDone,
        windowsTotal: windowsTotal() - 1,
      });
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
    windowsDone++;
  }

  log.info(
    `Completed repo listing for ${repo}: ${prs.length} PRs listed, matching ${matchingPRs}, complete=${isComplete}`,
  );
  return { prs, matchingPRs, isComplete, partialReasons };
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

// Lists the PRs created in the range. Oversized windows are split to get past the
// 1000-result Search limit. Repos are expected normalized (see normalizeRepos).
export async function listPullRequests(
  {
    repos,
    label,
    since,
    until,
  }: {
    repos: string[];
    label?: string;
    since?: string;
    until?: string;
  },
  run: GitHubRun,
): Promise<PullRequestListing> {
  const dateRange = normalizeDateRange(since, until);
  log.info(
    `Starting listing across ${repos.length} repos in range ${dateRange.since}..${dateRange.until}${label ? ` [label:${label}]` : ""}`,
  );
  const prs: ListedPullRequest[] = [];
  const partialReasons: string[] = [];
  let matchingPRs = 0;
  let isComplete = true;

  const searchPage: SearchPullRequestPage = (searchQuery, after) => {
    const variables: Record<string, GraphqlVariable> = { searchQuery, first: SEARCH_PAGE_SIZE };
    if (after) variables.after = after;
    return github.query<ListingResponse>(PR_LISTING_QUERY, variables, run);
  };

  for (const [repoIndex, repo] of repos.entries()) {
    const repoListing = await listRepoPullRequests({
      repo,
      label,
      range: dateRange,
      searchPage,
      onProgress: (progress) =>
        run.report({ phase: "listing", repo, repoIndex, repoCount: repos.length, ...progress }),
    });
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
