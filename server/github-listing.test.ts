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
  expect(progress).toEqual([
    { listed: 0, matching: null, page: 0, windowsDone: 0, windowsTotal: 1 },
    // The range was split after its first page; that page's PRs are listed again per half.
    { listed: 0, matching: 1500, page: 0, windowsDone: 0, windowsTotal: 2 },
    { listed: 100, matching: 1500, page: 1, windowsDone: 0, windowsTotal: 2 },
    { listed: 150, matching: 1500, page: 2, windowsDone: 0, windowsTotal: 2 },
    { listed: 200, matching: 1500, page: 1, windowsDone: 1, windowsTotal: 2 },
    // Every window listed: windowsDone reaches windowsTotal.
    { listed: 200, matching: 1500, page: 1, windowsDone: 2, windowsTotal: 2 },
  ]);
});
