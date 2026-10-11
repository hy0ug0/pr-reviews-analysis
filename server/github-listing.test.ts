import { expect, test } from "bun:test";
import {
  listRepoPullRequests,
  type ListingResponse,
  type RepoListingCounts,
  type SearchPullRequestPage,
} from "./github-listing.ts";

const REPO = "acme/widgets";
const RANGE = { since: "2026-01-01", until: "2026-01-04" };

function prs(from: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: from + index,
    updatedAt: "2026-01-05T00:00:00Z",
  }));
}

// A fake Search: the whole range matches 1500 PRs, past the 1000-result limit, so it is
// split in two days each. The first half has 150 PRs (two pages), the second 50.
const windows: Record<string, { issueCount: number; nodes: ReturnType<typeof prs> }> = {
  "2026-01-01..2026-01-04": { issueCount: 1500, nodes: prs(1, 100) },
  "2026-01-01..2026-01-02": { issueCount: 150, nodes: prs(1, 150) },
  "2026-01-03..2026-01-04": { issueCount: 50, nodes: prs(1001, 50) },
};

const searchPage: SearchPullRequestPage = async (searchQuery, after) => {
  const range = /created:(\S+)/.exec(searchQuery)?.[1] ?? "";
  const window = windows[range];
  const start = after === null ? 0 : Number(after);
  const nodes = window.nodes.slice(start, start + 100);
  const end = start + nodes.length;
  const response: ListingResponse = {
    search: {
      issueCount: window.issueCount,
      pageInfo: { hasNextPage: end < window.nodes.length, endCursor: String(end) },
      nodes,
    },
  };
  return response;
};

// Windows listed side by side report in whatever order their pages arrive, so the tests check
// what holds in any order: listed never goes down, and the repo is listed only at the end.
function expectSteadyProgress(progress: RepoListingCounts[]) {
  for (const [index, snapshot] of progress.entries()) {
    if (index > 0) expect(snapshot.listed).toBeGreaterThanOrEqual(progress[index - 1].listed);
    if (index < progress.length - 1) {
      expect(snapshot.windowsDone).toBeLessThan(snapshot.windowsTotal);
    }
  }
}

test("reports the range total from the first page, each page across split windows, then the end", async () => {
  const progress: RepoListingCounts[] = [];

  const listing = await listRepoPullRequests({
    repo: REPO,
    label: undefined,
    range: RANGE,
    searchPage,
    onProgress: (snapshot) => progress.push(snapshot),
  });

  expect(listing.prs).toHaveLength(200);
  expect(progress.slice(0, 2)).toEqual([
    { listed: 0, matching: null, windowsDone: 0, windowsTotal: 1 },
    // The range was split after its first page; that page's PRs are listed again per half.
    { listed: 0, matching: 1500, windowsDone: 0, windowsTotal: 2 },
  ]);
  // One snapshot per page kept (2 in the first half, 1 in the second), one when the first
  // half to finish is listed, then the end.
  expect(progress).toHaveLength(2 + 3 + 1 + 1);
  expect(progress).toContainEqual({ listed: 200, matching: 1500, windowsDone: 1, windowsTotal: 2 });
  // Every window listed: windowsDone reaches windowsTotal.
  expect(progress.at(-1)).toEqual({ listed: 200, matching: 1500, windowsDone: 2, windowsTotal: 2 });
  expectSteadyProgress(progress);
});

// A fake Search over PRs created on given days: each window's issueCount and pages come
// from the PRs of its days. `firstPages` records the window of each first page, in order.
function searchByDay(prsPerDay: Record<string, number>) {
  const created: { day: string; pr: { number: number; updatedAt: string } }[] = [];
  for (const [day, count] of Object.entries(prsPerDay)) {
    for (const pr of prs(created.length + 1, count)) created.push({ day, pr });
  }
  const firstPages: string[] = [];
  const search: SearchPullRequestPage = async (searchQuery, after) => {
    const range = /created:(\S+)/.exec(searchQuery)?.[1] ?? "";
    const [since, until] = range.split("..");
    if (after === null) firstPages.push(range);
    const matching = created.filter(({ day }) => day >= since && day <= until);
    const start = after === null ? 0 : Number(after);
    const end = Math.min(start + 100, matching.length);
    return {
      search: {
        issueCount: matching.length,
        pageInfo: { hasNextPage: end < matching.length, endCursor: String(end) },
        nodes: matching.slice(start, end).map(({ pr }) => pr),
      },
    };
  };
  return { search, firstPages };
}

test("cuts an oversized window once into parts sized from its count, listed in date order", async () => {
  // 3000 PRs over 10 days: 4 parts of about 800, each under the limit.
  const days = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `2026-01-${String(index + 1).padStart(2, "0")}`,
      300,
    ]),
  );
  const { search, firstPages } = searchByDay(days);
  const progress: RepoListingCounts[] = [];

  const listing = await listRepoPullRequests({
    repo: REPO,
    label: undefined,
    range: { since: "2026-01-01", until: "2026-01-10" },
    searchPage: search,
    onProgress: (snapshot) => progress.push(snapshot),
  });

  expect(firstPages).toEqual([
    "2026-01-01..2026-01-10",
    "2026-01-01..2026-01-02",
    "2026-01-03..2026-01-05",
    "2026-01-06..2026-01-07",
    "2026-01-08..2026-01-10",
  ]);
  expect(listing).toEqual({
    prs: prs(1, 3000).map(({ number, updatedAt }) => ({ repo: REPO, number, updatedAt })),
    matchingPRs: 3000,
    isComplete: true,
    partialReasons: [],
  });
  expect(progress[1]).toEqual({
    listed: 0,
    matching: 3000,
    windowsDone: 0,
    windowsTotal: 4,
  });
  expect(progress.at(-1)).toEqual({
    listed: 3000,
    matching: 3000,
    windowsDone: 4,
    windowsTotal: 4,
  });
});

test("cuts a part again when its days hold more PRs than the even spread assumed", async () => {
  // 1300 PRs make 2 parts; the second holds 1100 and is cut into its 2 days.
  const { search, firstPages } = searchByDay({
    "2026-01-01": 100,
    "2026-01-02": 100,
    "2026-01-03": 100,
    "2026-01-04": 1000,
  });
  const progress: RepoListingCounts[] = [];

  const listing = await listRepoPullRequests({
    repo: REPO,
    label: undefined,
    range: RANGE,
    searchPage: search,
    onProgress: (snapshot) => progress.push(snapshot),
  });

  expect(firstPages).toEqual([
    "2026-01-01..2026-01-04",
    "2026-01-01..2026-01-02",
    "2026-01-03..2026-01-04",
    "2026-01-03..2026-01-03",
    "2026-01-04..2026-01-04",
  ]);
  expect(listing.prs).toHaveLength(1300);
  expect(listing.matchingPRs).toBe(1300);
  expect(listing.isComplete).toBe(true);
  // The second part is replaced by its 2 days: 3 windows in all.
  expect(progress.map(({ windowsTotal }) => windowsTotal)).toContain(3);
  expectSteadyProgress(progress);
  expect(progress.at(-1)).toEqual({
    listed: 1300,
    matching: 1300,
    windowsDone: 3,
    windowsTotal: 3,
  });
});

test("cuts a window into no more parts than it has days, across a leap day", async () => {
  // 2700 PRs would make 4 parts, but 3 days make at most 3.
  const { search, firstPages } = searchByDay({
    "2024-02-28": 900,
    "2024-02-29": 900,
    "2024-03-01": 900,
  });

  const listing = await listRepoPullRequests({
    repo: REPO,
    label: undefined,
    range: { since: "2024-02-28", until: "2024-03-01" },
    searchPage: search,
  });

  expect(firstPages).toEqual([
    "2024-02-28..2024-03-01",
    "2024-02-28..2024-02-28",
    "2024-02-29..2024-02-29",
    "2024-03-01..2024-03-01",
  ]);
  expect(listing.prs).toHaveLength(2700);
  expect(listing.isComplete).toBe(true);
});

test("lists the first 1000 PRs of a single day past the limit and reports it partial", async () => {
  const { search, firstPages } = searchByDay({ "2026-01-01": 1200 });

  const listing = await listRepoPullRequests({
    repo: REPO,
    label: undefined,
    range: { since: "2026-01-01", until: "2026-01-01" },
    searchPage: search,
  });

  expect(firstPages).toEqual(["2026-01-01..2026-01-01"]);
  expect(listing.prs).toHaveLength(1000);
  expect(listing.matchingPRs).toBe(1200);
  expect(listing.isComplete).toBe(false);
  expect(listing.partialReasons).toEqual([
    `A single-day window (2026-01-01) in ${REPO} has more than 1000 matching PRs and cannot be split further.`,
    `GitHub Search limit reached for ${REPO} (2026-01-01..2026-01-01); only first 1000 PRs were accessible in this window.`,
  ]);
});

test("lists the parts of a split window side by side", async () => {
  // 3000 PRs over 10 days make 4 parts. Each request waits for a timer, so the requests in
  // flight show how many windows are listed at once.
  const days = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `2026-01-${String(index + 1).padStart(2, "0")}`,
      300,
    ]),
  );
  const { search } = searchByDay(days);
  let inFlight = 0;
  let maxInFlight = 0;
  const slowSearch: SearchPullRequestPage = async (searchQuery, after) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return search(searchQuery, after);
  };

  const listing = await listRepoPullRequests({
    repo: REPO,
    label: undefined,
    range: { since: "2026-01-01", until: "2026-01-10" },
    searchPage: slowSearch,
  });

  expect(maxInFlight).toBe(4);
  expect(listing.prs.map(({ number }) => number)).toEqual(prs(1, 3000).map(({ number }) => number));
});

test("fails with the error of a failing window", async () => {
  const { search } = searchByDay({
    "2026-01-01": 600,
    "2026-01-02": 600,
    "2026-01-03": 600,
  });
  const failingSearch: SearchPullRequestPage = (searchQuery, after) =>
    searchQuery.includes("created:2026-01-02..2026-01-02")
      ? Promise.reject(new Error("GitHub said no"))
      : search(searchQuery, after);

  const failure = await listRepoPullRequests({
    repo: REPO,
    label: undefined,
    range: { since: "2026-01-01", until: "2026-01-03" },
    searchPage: failingSearch,
  }).catch((error: unknown) => error);

  expect(failure).toEqual(new Error("GitHub said no"));
});
