import { beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { AnalysisProgress } from "../shared/types.ts";
import { createGitHubRun } from "./github-run.ts";
import type { PullRequestNode } from "./pull-request-model.ts";

// listPullRequests and fetchPullRequestDetails against a fake GitHub behind the real client,
// so the repos really run side by side under the client's request limit.

const MAX_IN_FLIGHT = 4;
const RANGE = { since: "2026-01-01", until: "2026-01-31" };

interface FakeRepo {
  numbers: number[];
  // How long each request about this repo takes.
  delayMs: number;
  failListing?: boolean;
  // Instead of `numbers`, this many PRs created each day, so a search over a date window
  // matches that window's days only and a large range is split.
  perDay?: number;
  // A window, as "since..until", whose search fails.
  failWindow?: string;
  failDetails?: boolean;
  // PRs with a second page of reviews.
  moreReviews?: number[];
}

let fakeRepos = new Map<string, FakeRepo>();
// Each search request, as "repo page", in the order they were sent.
const searches: string[] = [];
let inFlight = 0;
let peakInFlight = 0;
const reposInFlight = new Map<string, number>();
let peakReposInFlight = 0;

const requestSchema = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

function makeNode(repo: string, number: number, moreReviews: boolean): PullRequestNode {
  return {
    number,
    title: `Change #${number}`,
    state: "MERGED",
    url: `https://github.com/${repo}/pull/${number}`,
    createdAt: "2026-01-10T09:00:00Z",
    updatedAt: "2026-01-12T09:00:00Z",
    mergedAt: "2026-01-12T09:00:00Z",
    closedAt: "2026-01-12T09:00:00Z",
    isDraft: false,
    author: { login: "erin", __typename: "User" },
    timelineItems: { nodes: [] },
    reviews: {
      pageInfo: { hasNextPage: moreReviews, endCursor: `cursor-${number}` },
      nodes: [
        {
          author: { login: "alice", __typename: "User" },
          state: "APPROVED",
          submittedAt: "2026-01-11T10:00:00Z",
        },
      ],
    },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequestEvents: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

// Days from RANGE.since to a YYYY-MM-DD day.
function dayIndex(day: string): number {
  return (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${RANGE.since}T00:00:00Z`)) / 86_400_000;
}

// The PRs created in a "since..until" window, perDay a day from RANGE.since, numbered from
// 1 in creation order.
function createdIn(window: string, perDay: number): number[] {
  const [since, until] = window.split("..").map(dayIndex);
  return range(since * perDay + 1, (until - since + 1) * perDay);
}

function fakeRepo(repo: string): FakeRepo {
  const found = fakeRepos.get(repo);
  if (!found) throw new Error(`Unexpected repo ${repo}`);
  return found;
}

// The GraphQL answer for one request: a search page, a batch of PRs or a page of reviews.
function answer(body: string): { repo: string; response: unknown } {
  const { query, variables } = requestSchema.parse(JSON.parse(body));
  const { searchQuery, after, owner, name, number } = variables;

  if (typeof searchQuery === "string") {
    const repo = /repo:(\S+)/.exec(searchQuery)?.[1] ?? "";
    const window = /created:(\S+)/.exec(searchQuery)?.[1] ?? "";
    const { failListing, perDay, failWindow } = fakeRepo(repo);
    const numbers = perDay === undefined ? fakeRepo(repo).numbers : createdIn(window, perDay);
    searches.push(
      `${repo} ${perDay === undefined ? "" : `${window} `}${typeof after === "string" ? after : "first"}`,
    );
    if (failListing || window === failWindow) {
      const where = failListing ? repo : `${repo} in ${window}`;
      return {
        repo,
        response: { data: null, errors: [{ type: "INVALID", message: `Cannot search ${where}` }] },
      };
    }
    const start = typeof after === "string" ? Number(after) : 0;
    const nodes = numbers
      .slice(start, start + 100)
      .map((prNumber) => ({ number: prNumber, updatedAt: "2026-01-12T09:00:00Z" }));
    const end = start + nodes.length;
    return {
      repo,
      response: {
        data: {
          search: {
            issueCount: numbers.length,
            pageInfo: { hasNextPage: end < numbers.length, endCursor: String(end) },
            nodes,
          },
        },
      },
    };
  }

  const repo = `${String(owner)}/${String(name)}`;
  if (typeof number === "number") {
    const reviews = {
      pageInfo: { hasNextPage: false, endCursor: "end" },
      nodes: [
        {
          author: { login: "carol", __typename: "User" },
          state: "COMMENTED",
          submittedAt: "2026-01-11T12:00:00Z",
        },
      ],
    };
    return { repo, response: { data: { repository: { pullRequest: { reviews } } } } };
  }

  const { failDetails, moreReviews = [] } = fakeRepo(repo);
  if (failDetails) {
    return {
      repo,
      response: {
        data: { repository: null },
        errors: [
          { type: "NOT_FOUND", message: `Could not resolve to a Repository named ${repo}.` },
        ],
      },
    };
  }
  const repository: Record<string, PullRequestNode> = {};
  for (const [, alias, prNumber] of query.matchAll(/(pr(\d+)): pullRequest/g)) {
    repository[alias] = makeNode(repo, Number(prNumber), moreReviews.includes(Number(prNumber)));
  }
  return { repo, response: { data: { repository } } };
}

const realClient = await import("./github-client.ts");
const client = realClient.createGitHubClient({
  fetch: async (_url, init) => {
    if (typeof init.body !== "string") throw new Error("Expected a string body");
    const { repo, response } = answer(init.body);
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    reposInFlight.set(repo, (reposInFlight.get(repo) ?? 0) + 1);
    peakReposInFlight = Math.max(peakReposInFlight, reposInFlight.size);
    await Bun.sleep(fakeRepo(repo).delayMs);
    inFlight--;
    const left = (reposInFlight.get(repo) ?? 1) - 1;
    if (left === 0) reposInFlight.delete(repo);
    else reposInFlight.set(repo, left);
    return new Response(JSON.stringify(response), { status: 200 });
  },
  tokenProvider: { get: () => Promise.resolve("token"), refresh: () => Promise.resolve("token") },
  sleep: () => Promise.resolve(),
  maxConcurrentRequests: MAX_IN_FLIGHT,
});
await mock.module("./github-client.ts", () => ({ ...realClient, github: client }));
const { listPullRequests } = await import("./github-listing.ts");
const { fetchPullRequestDetails } = await import("./github-pull-request-details.ts");

const REPOS = ["acme/a", "acme/b", "acme/c"];

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

// The first repo is the slowest, so the repos finish in the reverse of their order.
function setRepos(delays: number[], extra: Partial<Record<string, Partial<FakeRepo>>> = {}) {
  const numbers = [range(1, 250), range(1001, 30), range(2001, 120)];
  fakeRepos = new Map(
    REPOS.map((repo, index) => [
      repo,
      { numbers: numbers[index], delayMs: delays[index], ...extra[repo] },
    ]),
  );
}

function setFakeRepos(repos: Record<string, FakeRepo>) {
  fakeRepos = new Map(Object.entries(repos));
}

beforeEach(() => {
  searches.length = 0;
  inFlight = 0;
  peakInFlight = 0;
  reposInFlight.clear();
  peakReposInFlight = 0;
});

function recordingRun() {
  const snapshots: AnalysisProgress[] = [];
  const run = createGitHubRun((progress) => snapshots.push(progress));
  return { run, snapshots };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected a rejection");
}

describe("listPullRequests", () => {
  test("lists the repos side by side, within the request limit, in the order of the repos", async () => {
    setRepos([12, 1, 4]);
    const slowFirst = await listPullRequests({ repos: REPOS, ...RANGE }, createGitHubRun());
    const slowFirstPeak = { requests: peakInFlight, repos: peakReposInFlight };
    setRepos([1, 4, 12]);
    const fastFirst = await listPullRequests({ repos: REPOS, ...RANGE }, createGitHubRun());

    expect(slowFirst.prs.map(({ repo, number }) => `${repo}#${number}`)).toEqual([
      ...range(1, 250).map((number) => `acme/a#${number}`),
      ...range(1001, 30).map((number) => `acme/b#${number}`),
      ...range(2001, 120).map((number) => `acme/c#${number}`),
    ]);
    expect(slowFirst).toMatchObject({ matchingPRs: 400, isComplete: true, partialReasons: [] });
    expect(fastFirst).toEqual(slowFirst);
    expect(slowFirstPeak.repos).toBe(3);
    expect(slowFirstPeak.requests).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  });

  test("every snapshot has one entry per repo in query order, and each repo ends listed", async () => {
    setRepos([12, 1, 4]);
    const { run, snapshots } = recordingRun();

    await listPullRequests({ repos: REPOS, ...RANGE }, run);

    for (const snapshot of snapshots) {
      if (snapshot.phase !== "listing") throw new Error(`Unexpected ${snapshot.phase}`);
      expect(snapshot.repos.map(({ repo }) => repo)).toEqual(REPOS);
    }
    expect(snapshots[0]).toEqual({
      phase: "listing",
      repos: REPOS.map((repo) => ({
        repo,
        listed: 0,
        matching: null,

        windowsDone: 0,
        windowsTotal: 1,
      })),
    });
    expect(snapshots.at(-1)).toEqual({
      phase: "listing",
      repos: [
        { repo: "acme/a", listed: 250, matching: 250, windowsDone: 1, windowsTotal: 1 },
        { repo: "acme/b", listed: 30, matching: 30, windowsDone: 1, windowsTotal: 1 },
        { repo: "acme/c", listed: 120, matching: 120, windowsDone: 1, windowsTotal: 1 },
      ],
    });
    // The last repo to finish is the first one, which a sequential listing finished first.
    expect(snapshots.at(-2)).toMatchObject({ repos: [{ windowsDone: 0 }, {}, {}] });
  });

  test("fails with the first failing repo in query order, as listing one by one did", async () => {
    // acme/c fails first in time, but acme/b comes first in the query.
    setRepos([1, 12, 1], { "acme/b": { failListing: true }, "acme/c": { failListing: true } });

    expect(await rejection(listPullRequests({ repos: REPOS, ...RANGE }, createGitHubRun()))).toBe(
      "Cannot search acme/b",
    );
  });
});

describe("listPullRequests after a repo fails", () => {
  test("the other repos send no further page, and the listing rejects with the failure", async () => {
    // acme/a fails on its first page while acme/z, 3 pages long, is still on its first.
    setFakeRepos({
      "acme/a": { numbers: [], delayMs: 1, failListing: true },
      "acme/z": { numbers: range(1, 250), delayMs: 10 },
    });

    const message = await rejection(
      listPullRequests({ repos: ["acme/a", "acme/z"], ...RANGE }, createGitHubRun()),
    );

    expect(message).toBe("Cannot search acme/a");
    expect(searches).toEqual(["acme/a first", "acme/z first"]);
  });

  test("an earlier repo stopped by a later failure does not hide that failure", async () => {
    setFakeRepos({
      "acme/a": { numbers: range(1, 250), delayMs: 10 },
      "acme/b": { numbers: [], delayMs: 1, failListing: true },
    });

    const message = await rejection(
      listPullRequests({ repos: ["acme/a", "acme/b"], ...RANGE }, createGitHubRun()),
    );

    expect(message).toBe("Cannot search acme/b");
    expect(searches.filter((search) => search.startsWith("acme/a"))).toEqual(["acme/a first"]);
  });
});

describe("listPullRequests with a range split into more windows than slots", () => {
  // 200 PRs a day over January: 6200 PRs, cut into 8 windows of about 800.
  const FIRST_WINDOW = "2026-01-01..2026-01-03";
  const SECOND_WINDOW = "2026-01-04..2026-01-07";

  test("lists the windows side by side within the request limit, in date order", async () => {
    setFakeRepos({ "acme/a": { numbers: [], perDay: 200, delayMs: 2 } });

    const listing = await listPullRequests({ repos: ["acme/a"], ...RANGE }, createGitHubRun());

    expect(listing.prs.map(({ number }) => number)).toEqual(range(1, 6200));
    expect(listing.isComplete).toBe(true);
    expect(peakInFlight).toBe(MAX_IN_FLIGHT);
  });

  test("a failing window stops the windows still queued for a slot", async () => {
    setFakeRepos({
      "acme/a": { numbers: [], perDay: 200, delayMs: 2, failWindow: FIRST_WINDOW },
    });

    const message = await rejection(
      listPullRequests({ repos: ["acme/a"], ...RANGE }, createGitHubRun()),
    );

    // The listing rejects before the requests it already queued are done with.
    await Bun.sleep(30);
    expect(message).toBe(`Cannot search acme/a in ${FIRST_WINDOW}`);
    // The range's first page, the 4 first pages that had a slot when the window failed, and
    // at most one more: the failed request frees its slot just before the stop lands. The
    // other windows still queued send nothing.
    expect(searches.filter((search) => search.endsWith(" first")).length).toBeLessThanOrEqual(
      1 + MAX_IN_FLIGHT + 1,
    );
  });

  test("a window stopped by another repo's failure does not hide its own failure", async () => {
    // acme/b fails while acme/a's first windows are in flight. The first window then asks
    // for its next page and is stopped; the second answers just after with its own failure.
    setFakeRepos({
      "acme/a": { numbers: [], perDay: 200, delayMs: 10, failWindow: SECOND_WINDOW },
      "acme/b": { numbers: [], delayMs: 15, failListing: true },
    });

    const message = await rejection(
      listPullRequests({ repos: ["acme/a", "acme/b"], ...RANGE }, createGitHubRun()),
    );

    expect(message).toBe(`Cannot search acme/a in ${SECOND_WINDOW}`);
  });
});

describe("fetchPullRequestDetails", () => {
  // Interleaved across repos, as a listing with cached PRs left out can be.
  const refs = [
    ...range(1, 60).map((number) => ({ repo: "acme/a", number })),
    ...range(1001, 30).map((number) => ({ repo: "acme/b", number })),
    ...range(2001, 40).map((number) => ({ repo: "acme/c", number })),
    { repo: "acme/a", number: 200 },
  ];

  test("fetches the repos side by side, within the request limit, with the same results in any order of completion", async () => {
    setRepos([12, 1, 4], { "acme/a": { moreReviews: [3, 200] } });
    const slowRun = createGitHubRun();
    const slowFirst = await fetchPullRequestDetails(refs, slowRun);
    const slowFirstPeak = { requests: peakInFlight, repos: peakReposInFlight };
    setRepos([1, 4, 12], { "acme/a": { moreReviews: [3, 200] } });
    const fastRun = createGitHubRun();
    const fastFirst = await fetchPullRequestDetails(refs, fastRun);

    expect(Array.from(slowFirst.keys())).toEqual([
      ...range(1, 60).map((number) => `acme/a#${number}`),
      "acme/a#200",
      ...range(1001, 30).map((number) => `acme/b#${number}`),
      ...range(2001, 40).map((number) => `acme/c#${number}`),
    ]);
    expect(Array.from(slowFirst.values()).every(({ kind }) => kind === "complete")).toBe(true);
    const third = slowFirst.get("acme/a#3");
    expect(
      third?.kind === "complete" &&
        third.pullRequest.reviews.nodes.map((review) => review.author?.login),
    ).toEqual(["alice", "carol"]);
    expect(Array.from(fastFirst)).toEqual(Array.from(slowFirst));
    // 3 + 2 + 2 batches of up to 25, and 2 review pages.
    expect(slowRun.requests).toBe(9);
    expect(fastRun.requests).toBe(9);
    // acme/a's 3 batches and one of acme/b's fill the 4 slots.
    expect(slowFirstPeak.repos).toBeGreaterThan(1);
    expect(slowFirstPeak.requests).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  });

  test("a repo that cannot be fetched fails only its own PRs", async () => {
    setRepos([4, 1, 4], { "acme/b": { failDetails: true } });

    const fetched = await fetchPullRequestDetails(refs, createGitHubRun());

    expect(fetched.get("acme/b#1001")).toEqual({
      kind: "failed",
      number: 1001,
      reason: "Failed to fetch acme/b#1001: Could not resolve to a Repository named acme/b.",
    });
    const kinds = Array.from(fetched, ([key, result]) => `${key.split("#")[0]} ${result.kind}`);
    expect(new Set(kinds)).toEqual(
      new Set(["acme/a complete", "acme/b failed", "acme/c complete"]),
    );
  });

  test("every snapshot has one entry per repo with PRs to fetch, and each repo ends fetched", async () => {
    setRepos([12, 1, 4], { "acme/a": { moreReviews: [3] } });
    const { run, snapshots } = recordingRun();

    await fetchPullRequestDetails(refs, run);

    for (const snapshot of snapshots) {
      if (snapshot.phase !== "fetching") throw new Error(`Unexpected ${snapshot.phase}`);
      expect(snapshot.repos.map(({ repo }) => repo)).toEqual(REPOS);
    }
    expect(snapshots.at(-1)).toEqual({
      phase: "fetching",
      repos: [
        {
          repo: "acme/a",
          prsDone: 61,
          prsTotal: 61,
          batchesDone: 3,
          batchesTotal: 3,
          reviewPRsDone: 1,
          reviewPRsTotal: 1,
        },
        {
          repo: "acme/b",
          prsDone: 30,
          prsTotal: 30,
          batchesDone: 2,
          batchesTotal: 2,
          reviewPRsDone: 0,
          reviewPRsTotal: 0,
        },
        {
          repo: "acme/c",
          prsDone: 40,
          prsTotal: 40,
          batchesDone: 2,
          batchesTotal: 2,
          reviewPRsDone: 0,
          reviewPRsTotal: 0,
        },
      ],
    });
  });
});
