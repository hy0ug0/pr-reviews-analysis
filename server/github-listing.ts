import { GITHUB_EPOCH_DATE, todayUtc } from "../shared/schemas.ts";
import { github, type GraphqlVariable } from "./github-client.ts";
import type { GitHubRun } from "./github-run.ts";
import { uniqueReasons } from "./lib/partial-reasons.ts";
import { createLogger } from "./logger.ts";
import type { PullRequestRef } from "./pull-request-details.ts";
import type { PageInfo } from "./pull-request-model.ts";

// Lists the PRs a search matches, without their data, splitting date windows past the
// 1000-result Search limit.

const log = createLogger("fetch");

const SEARCH_PAGE_SIZE = 100;
const SEARCH_HARD_LIMIT = 1000;
const MAX_SEARCH_PAGES = SEARCH_HARD_LIMIT / SEARCH_PAGE_SIZE;
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

function buildSearchQuery(repo: string, label?: string, since?: string, until?: string): string {
  let query = `repo:${repo} type:pr`;
  if (label) query += ` label:"${label}"`;
  if (since && until) query += ` created:${since}..${until}`;
  else if (since) query += ` created:>=${since}`;
  else if (until) query += ` created:<=${until}`;
  return query;
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
