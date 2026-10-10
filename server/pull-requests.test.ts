import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { listPullRequests, PullRequestListing } from "./github-listing.ts";
import type { fetchPullRequestDetails } from "./github-pull-request-details.ts";
import type { GitHubRun } from "./github-run.ts";
import type { AnalysisProgress } from "../shared/types.ts";
import type { FetchedPullRequest, PullRequestRef } from "./pull-request-details.ts";
import { pullRequestSchema, type PullRequest } from "./pull-request-model.ts";

const REPO = "acme/widgets";

// A fake GitHub: PRs by "repo#number", and outcomes that replace a PR's normal fetch.
let remotePRs = new Map<string, PullRequest>();
let fetchOverrides = new Map<string, FetchedPullRequest>();
let listingExtras: Pick<PullRequestListing, "isComplete" | "partialReasons"> = {
  isComplete: true,
  partialReasons: [],
};
// How long each fake GitHub call takes, by repo. Calls yield either way, so concurrent loads
// interleave their requests.
let callDelayMs = new Map<string, number>();

async function fakeGitHubCall(run: GitHubRun, repo: string) {
  run.requests++;
  await Bun.sleep(callDelayMs.get(repo) ?? 0);
}

// One listing request per repo and one detail request per PR, so request counts are easy
// to predict.
const listMock = mock(
  async (
    { repos }: Parameters<typeof listPullRequests>[0],
    run: GitHubRun,
  ): Promise<PullRequestListing> => {
    for (const repo of repos) await fakeGitHubCall(run, repo);
    const prs = Array.from(remotePRs, ([key, pr]) => ({
      repo: key.slice(0, key.indexOf("#")),
      number: pr.number,
      updatedAt: pr.updatedAt,
    })).filter((listed) => repos.includes(listed.repo));
    return { prs, matchingPRs: prs.length, ...listingExtras };
  },
);
const detailsMock = mock(
  async (refs: Parameters<typeof fetchPullRequestDetails>[0], run: GitHubRun) => {
    for (const [index, ref] of refs.entries()) {
      await fakeGitHubCall(run, ref.repo);
      run.report({
        phase: "fetching",
        repo: ref.repo,
        repoIndex: 0,
        repoCount: 1,
        prsDone: index + 1,
        prsTotal: refs.length,
        repoPRsDone: index + 1,
        repoPRsTotal: refs.length,
        batchesDone: index + 1,
        batchesTotal: refs.length,
        reviewPRsDone: 0,
        reviewPRsTotal: null,
      });
    }
    return new Map(
      refs.map((ref): [string, FetchedPullRequest] => {
        const key = `${ref.repo}#${ref.number}`;
        const remote = remotePRs.get(key);
        const outcome: FetchedPullRequest = remote
          ? { kind: "complete", pullRequest: remote }
          : { kind: "failed", number: ref.number, reason: `missing ${key}` };
        return [key, fetchOverrides.get(key) ?? outcome];
      }),
    );
  },
);
await mock.module("./github-listing.ts", () => ({
  listPullRequests: listMock,
}));
await mock.module("./github-pull-request-details.ts", () => ({
  fetchPullRequestDetails: detailsMock,
}));

// cache.ts reads CACHE_DIR once at load time, so set it only around the import.
const cacheDir = join(tmpdir(), `pr-reviews-analysis-test-${randomUUID()}`);
const previousCacheDir = process.env.CACHE_DIR;
process.env.CACHE_DIR = cacheDir;
const { buildCacheKey, getCacheConfig, readCache, writeCache } = await import("./cache.ts");
const {
  buildListingCacheKey,
  buildPullRequestCacheKey,
  cachedListingSchema,
  classifyCachedPullRequest,
  loadPullRequests,
  normalizeRepos,
} = await import("./pull-requests.ts");
if (previousCacheDir === undefined) delete process.env.CACHE_DIR;
else process.env.CACHE_DIR = previousCacheDir;

if (getCacheConfig().cacheDir !== cacheDir) {
  throw new Error("cache.ts was loaded before CACHE_DIR was set");
}

afterAll(() => rm(cacheDir, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  remotePRs = new Map();
  fetchOverrides = new Map();
  listingExtras = { isComplete: true, partialReasons: [] };
  callDelayMs = new Map();
  listMock.mockClear();
  detailsMock.mockClear();
});

function makePR(number: number, updatedAt = "2026-03-20T09:00:00Z"): PullRequest {
  return {
    repo: REPO,
    number,
    title: `Widget change #${number}`,
    state: "MERGED",
    url: `https://github.com/${REPO}/pull/${number}`,
    createdAt: "2026-03-01T09:00:00Z",
    updatedAt,
    mergedAt: "2026-03-20T09:00:00Z",
    closedAt: "2026-03-20T09:00:00Z",
    isDraft: false,
    readyForReviewAt: "2026-03-02T09:00:00Z",
    author: { login: "alice", __typename: "User" },
    reviews: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: "bob", __typename: "User" },
          state: "APPROVED",
          submittedAt: "2026-03-15T12:00:00Z",
        },
      ],
    },
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { author: { login: "ci", __typename: "Bot" }, createdAt: "2026-03-01T09:05:00Z" },
        { author: null, createdAt: "2026-03-03T10:00:00Z" },
      ],
    },
    reviewRequests: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          kind: "requested",
          createdAt: "2026-03-02T09:00:00Z",
          reviewer: { kind: "user", login: "bob" },
        },
        { kind: "requested", createdAt: "2026-03-02T09:00:00Z", reviewer: null },
      ],
    },
  };
}

function setRemote(...prs: PullRequest[]) {
  for (const pr of prs) remotePRs.set(`${REPO}#${pr.number}`, pr);
}

function fetchedRefs(): PullRequestRef[][] {
  return detailsMock.mock.calls.map(([refs]) => refs);
}

const FAR_FUTURE = "2100-01-01T00:00:00.000Z";

// writeCache always stamps the current time, so an older entry is written by hand.
async function writePullRequestEntry(pr: PullRequest, cachedAt: string) {
  const key = buildPullRequestCacheKey({ repo: pr.repo, number: pr.number });
  await writeFile(
    cacheFilePath(key),
    JSON.stringify({ cachedAt, expiresAt: FAR_FUTURE, value: pr }),
    "utf8",
  );
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function cacheFilePath(key: string): string {
  return join(cacheDir, `${key}.json`);
}

const query = { repos: [REPO], since: "2026-03-01", until: "2026-03-31" };

describe("cache keys", () => {
  test("listing key ignores repo order, case, whitespace and duplicates", () => {
    const key = buildListingCacheKey({ repos: ["acme/widgets", "acme/gadgets"] });
    const variant = buildListingCacheKey({
      repos: [" Acme/Gadgets", "ACME/WIDGETS", "acme/widgets", ""],
    });

    expect(variant).toBe(key);
  });

  test("normalizes repos to a sorted, lowercase, unique list", () => {
    expect(normalizeRepos([" Acme/Widgets", "acme/gadgets", "ACME/WIDGETS", ""])).toEqual([
      "acme/gadgets",
      "acme/widgets",
    ]);
  });

  test("listing key changes when the label or date range changes", () => {
    const repos = [REPO];
    const keys = new Set([
      buildListingCacheKey({ repos }),
      buildListingCacheKey({ repos, label: "bug" }),
      buildListingCacheKey({ repos, since: "2026-03-01" }),
      buildListingCacheKey({ repos, until: "2026-03-31" }),
    ]);

    expect(keys.size).toBe(4);
  });

  test("listings and PRs have their own versioned namespaces", () => {
    expect(buildListingCacheKey({ repos: [REPO] })).toMatch(
      /^pull-request-listing-v3-[0-9a-f]{64}$/,
    );
    expect(buildPullRequestCacheKey({ repo: REPO, number: 1 })).toMatch(
      /^pull-request-v6-[0-9a-f]{64}$/,
    );
  });

  test("each PR has its own key", () => {
    expect(buildPullRequestCacheKey({ repo: REPO, number: 1 })).not.toBe(
      buildPullRequestCacheKey({ repo: REPO, number: 2 }),
    );
    expect(buildPullRequestCacheKey({ repo: REPO, number: 1 })).not.toBe(
      buildPullRequestCacheKey({ repo: "acme/gadgets", number: 1 }),
    );
  });
});

describe("cache entry validation", () => {
  test("returns a stored listing", async () => {
    const key = buildListingCacheKey({ repos: [REPO], label: "valid" });
    const listing = {
      listedAt: "2026-03-31T10:00:00.000Z",
      prs: [{ repo: REPO, number: 1, updatedAt: "2026-03-20T09:00:00Z" }],
      matchingPRs: 1,
      isComplete: false,
      partialReasons: ["GitHub Search limit reached"],
    };
    await writeCache(key, listing, "listing");

    expect(await readCache(key, cachedListingSchema)).toEqual({
      value: listing,
      cachedAt: expect.any(String),
    });
  });

  test("deletes a listing entry whose value does not match the schema", async () => {
    const key = buildListingCacheKey({ repos: [REPO], label: "wrong-shape" });
    await writeCache(
      key,
      { prs: [], matchingPRs: 0, isComplete: true, partialReasons: [] },
      "listing",
    );

    expect(await readCache(key, cachedListingSchema)).toBeNull();
    expect(await fileExists(cacheFilePath(key))).toBe(false);
  });

  test("returns a stored PR and when it was cached", async () => {
    const key = buildPullRequestCacheKey({ repo: REPO, number: 1 });
    const before = Date.now();
    await writeCache(key, makePR(1), "pullRequest");
    const cached = await readCache(key, pullRequestSchema);

    expect(cached?.value).toEqual(makePR(1));
    expect(Date.parse(cached?.cachedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
  });

  test("deletes a PR entry without updatedAt", async () => {
    const key = buildPullRequestCacheKey({ repo: REPO, number: 2 });
    const { updatedAt: _updatedAt, ...withoutUpdatedAt } = makePR(2);
    await writeCache(key, withoutUpdatedAt, "pullRequest");

    expect(await readCache(key, pullRequestSchema)).toBeNull();
    expect(await fileExists(cacheFilePath(key))).toBe(false);
  });

  test("deletes a PR entry that is not valid JSON", async () => {
    const key = buildPullRequestCacheKey({ repo: REPO, number: 3 });
    await writeFile(cacheFilePath(key), "not json{", "utf8");

    expect(await readCache(key, pullRequestSchema)).toBeNull();
    expect(await fileExists(cacheFilePath(key))).toBe(false);
  });
});

describe("classifyCachedPullRequest", () => {
  const listed = { repo: REPO, number: 1, updatedAt: "2026-03-20T09:00:00Z" };

  test("missing when nothing is cached", () => {
    expect(classifyCachedPullRequest(listed, null)).toEqual({ kind: "missing" });
  });

  const cachedAt = "2026-03-21T09:00:00.000Z";

  test("fresh when the cached updatedAt matches the listing", () => {
    expect(classifyCachedPullRequest(listed, { value: makePR(1), cachedAt })).toEqual({
      kind: "fresh",
      pullRequest: makePR(1),
      cachedAt,
    });
  });

  test("stale when the cached updatedAt differs from the listing", () => {
    expect(
      classifyCachedPullRequest(listed, { value: makePR(1, "2026-03-10T09:00:00Z"), cachedAt }),
    ).toEqual({
      kind: "stale",
      cachedUpdatedAt: "2026-03-10T09:00:00Z",
    });
  });
});

describe("loadPullRequests", () => {
  test("cold: lists, fetches every PR and caches both tiers", async () => {
    setRemote(makePR(1), makePR(2));

    const loaded = await loadPullRequests(query, { skipCache: false });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(fetchedRefs()).toEqual([
      [
        { repo: REPO, number: 1 },
        { repo: REPO, number: 2 },
      ],
    ]);
    expect(loaded.fetchResult).toEqual({
      prs: [makePR(1), makePR(2)],
      matchingPRs: 2,
      analyzedPRs: 2,
      isComplete: true,
      partialReasons: [],
    });
    expect(loaded.dataSource).toEqual({
      listing: "github",
      listedAt: expect.any(String),
      fetchedPRs: 2,
      reusedPRs: 0,
      oldestReusedCachedAt: null,
      githubRequests: 3,
      fetchDurationMs: expect.any(Number),
      skippedCache: false,
    });
    expect(
      (await readCache(buildPullRequestCacheKey({ repo: REPO, number: 2 }), pullRequestSchema))
        ?.value,
    ).toEqual(makePR(2));
  });

  test("listing hit: reuses every cached PR without calling GitHub", async () => {
    setRemote(makePR(1), makePR(2));
    const first = await loadPullRequests(query, { skipCache: false });
    detailsMock.mockClear();

    const second = await loadPullRequests(query, { skipCache: false });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(fetchedRefs()).toEqual([[]]);
    expect(second.fetchResult).toEqual(first.fetchResult);
    expect(second.dataSource).toEqual({
      listing: "cache",
      listedAt: first.dataSource.listedAt,
      fetchedPRs: 0,
      reusedPRs: 2,
      oldestReusedCachedAt: expect.any(String),
      githubRequests: 0,
      fetchDurationMs: null,
      skippedCache: false,
    });
  });

  test("listing hit: fetches a PR whose cache entry is gone", async () => {
    setRemote(makePR(1), makePR(2));
    await loadPullRequests(query, { skipCache: false });
    await rm(cacheFilePath(buildPullRequestCacheKey({ repo: REPO, number: 1 })));
    detailsMock.mockClear();

    const loaded = await loadPullRequests(query, { skipCache: false });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(fetchedRefs()).toEqual([[{ repo: REPO, number: 1 }]]);
    expect(loaded.fetchResult.prs).toEqual([makePR(1), makePR(2)]);
    expect(loaded.dataSource).toMatchObject({ listing: "cache", fetchedPRs: 1, reusedPRs: 1 });
  });

  test("skipCache: relists and refetches only new and updated PRs, in listing order", async () => {
    setRemote(makePR(1), makePR(2), makePR(3));
    await loadPullRequests(query, { skipCache: false });
    detailsMock.mockClear();
    // On GitHub, PR 2 got a new review and PR 4 was opened.
    const updated = { ...makePR(2, "2026-03-25T09:00:00Z"), title: "Updated" };
    setRemote(updated, makePR(4));

    const loaded = await loadPullRequests(query, { skipCache: true });

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(fetchedRefs()).toEqual([
      [
        { repo: REPO, number: 2 },
        { repo: REPO, number: 4 },
      ],
    ]);
    expect(loaded.fetchResult.prs).toEqual([makePR(1), updated, makePR(3), makePR(4)]);
    expect(loaded.dataSource).toMatchObject({
      listing: "github",
      fetchedPRs: 2,
      reusedPRs: 2,
      // One listing request plus one per refetched PR.
      githubRequests: 3,
      fetchDurationMs: expect.any(Number),
      skippedCache: true,
    });
    expect(
      (await readCache(buildPullRequestCacheKey({ repo: REPO, number: 2 }), pullRequestSchema))
        ?.value,
    ).toEqual(updated);
  });

  test("full hit: reports the oldest reused entry's cachedAt", async () => {
    setRemote(makePR(1), makePR(2));
    await loadPullRequests(query, { skipCache: false });
    const oldCachedAt = "2026-10-01T08:00:00.000Z";
    await writePullRequestEntry(makePR(2), oldCachedAt);

    const loaded = await loadPullRequests(query, { skipCache: false });

    expect(loaded.dataSource).toMatchObject({
      listing: "cache",
      reusedPRs: 2,
      oldestReusedCachedAt: oldCachedAt,
      githubRequests: 0,
      fetchDurationMs: null,
    });
  });

  test("miss: counts only the fake GitHub calls and times them", async () => {
    setRemote(makePR(1), makePR(2), makePR(3));
    callDelayMs.set(REPO, 20);

    const loaded = await loadPullRequests(query, { skipCache: false });

    expect(loaded.dataSource).toMatchObject({ githubRequests: 4, skippedCache: false });
    // Four calls of 20 ms each, one after the other.
    expect(loaded.dataSource.fetchDurationMs).toBeGreaterThanOrEqual(75);
  });

  test("skipCache with nothing cached: fetches everything and says the cache was skipped", async () => {
    setRemote(makePR(1));

    const loaded = await loadPullRequests(query, { skipCache: true });

    expect(loaded.dataSource).toEqual({
      listing: "github",
      listedAt: expect.any(String),
      fetchedPRs: 1,
      reusedPRs: 0,
      oldestReusedCachedAt: null,
      githubRequests: 2,
      fetchDurationMs: expect.any(Number),
      skippedCache: true,
    });
  });

  test("skipCache overwrites the listing entry", async () => {
    setRemote(makePR(1));
    await loadPullRequests(query, { skipCache: false });
    setRemote(makePR(2));

    await loadPullRequests(query, { skipCache: true });
    const listing = await readCache(buildListingCacheKey(query), cachedListingSchema);

    expect(listing?.value.prs.map((pr) => pr.number)).toEqual([1, 2]);
  });

  test("serves a partial PR but does not cache it", async () => {
    setRemote(makePR(1), makePR(2));
    const inlineOnly = { ...makePR(2), reviews: { pageInfo: { hasNextPage: true }, nodes: [] } };
    fetchOverrides.set(`${REPO}#2`, {
      kind: "partial",
      pullRequest: inlineOnly,
      reason: `Failed to fetch complete reviews for ${REPO}#2: timeout`,
    });

    const first = await loadPullRequests(query, { skipCache: false });

    expect(first.fetchResult.prs).toEqual([makePR(1), inlineOnly]);
    expect(first.fetchResult.isComplete).toBe(false);
    expect(first.fetchResult.partialReasons).toEqual([
      `Failed to fetch complete reviews for ${REPO}#2: timeout`,
    ]);
    expect(first.dataSource).toMatchObject({ fetchedPRs: 2, reusedPRs: 0 });
    expect(
      await fileExists(cacheFilePath(buildPullRequestCacheKey({ repo: REPO, number: 2 }))),
    ).toBe(false);

    fetchOverrides.clear();
    detailsMock.mockClear();
    const second = await loadPullRequests(query, { skipCache: false });

    expect(fetchedRefs()).toEqual([[{ repo: REPO, number: 2 }]]);
    expect(second.fetchResult.prs).toEqual([makePR(1), makePR(2)]);
    expect(second.fetchResult.isComplete).toBe(true);
  });

  test("leaves out a PR that failed to fetch and reports it", async () => {
    setRemote(makePR(1), makePR(2));
    fetchOverrides.set(`${REPO}#1`, { kind: "failed", number: 1, reason: "rate limited" });

    const loaded = await loadPullRequests(query, { skipCache: false });

    expect(loaded.fetchResult).toMatchObject({
      prs: [makePR(2)],
      matchingPRs: 2,
      analyzedPRs: 1,
      isComplete: false,
      partialReasons: ["rate limited"],
    });
    expect(loaded.dataSource).toMatchObject({ fetchedPRs: 1, reusedPRs: 0 });
  });

  test("keeps the listing's own partial reasons on a listing hit", async () => {
    setRemote(makePR(1));
    listingExtras = { isComplete: false, partialReasons: ["GitHub Search limit reached"] };
    await loadPullRequests(query, { skipCache: false });

    const loaded = await loadPullRequests(query, { skipCache: false });

    expect(loaded.dataSource.listing).toBe("cache");
    expect(loaded.fetchResult.isComplete).toBe(false);
    expect(loaded.fetchResult.partialReasons).toEqual(["GitHub Search limit reached"]);
  });

  test("lists with the normalized repo list", async () => {
    await loadPullRequests(
      {
        repos: [" Acme/Widgets", "acme/gadgets", "ACME/WIDGETS"],
        label: "bug",
        since: "2026-03-01",
        until: "2026-03-31",
      },
      { skipCache: true },
    );

    expect(listMock).toHaveBeenCalledWith(
      {
        repos: ["acme/gadgets", "acme/widgets"],
        label: "bug",
        since: "2026-03-01",
        until: "2026-03-31",
      },
      expect.anything(),
    );
  });

  test("never reads a version 1 entry", async () => {
    setRemote(makePR(1));
    // The key and value the version 1 code wrote for this query.
    const v1Key = buildCacheKey("pull-requests-v1", {
      repos: [REPO],
      label: null,
      since: query.since,
      until: query.until,
    });
    const v1Value = {
      prs: [],
      matchingPRs: 99,
      analyzedPRs: 0,
      isComplete: true,
      partialReasons: [],
    };
    await writeCache(v1Key, v1Value, "listing");

    const loaded = await loadPullRequests(query, { skipCache: false });

    expect(loaded.dataSource.listing).toBe("github");
    expect(loaded.fetchResult.matchingPRs).toBe(1);
    expect(await fileExists(cacheFilePath(v1Key))).toBe(true);
  });

  test("returns the result when the cache writes fail", async () => {
    setRemote(makePR(1));
    // Directories at the entry paths make the final renames fail.
    await mkdir(cacheFilePath(buildListingCacheKey(query)));
    await mkdir(cacheFilePath(buildPullRequestCacheKey({ repo: REPO, number: 1 })));

    const loaded = await loadPullRequests(query, { skipCache: true });

    expect(loaded.fetchResult.prs).toEqual([makePR(1)]);
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("concurrent loadPullRequests", () => {
  test("identical requests share one listing and one detail fetch", async () => {
    setRemote(makePR(1), makePR(2));

    const [first, second] = await Promise.all([
      loadPullRequests(query, { skipCache: false }),
      loadPullRequests({ ...query, repos: [" ACME/Widgets"] }, { skipCache: false }),
    ]);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(detailsMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  test("different queries in parallel count their own requests and time", async () => {
    const GADGETS = "acme/gadgets";
    setRemote(makePR(1), makePR(2), makePR(3));
    remotePRs.set(`${GADGETS}#7`, { ...makePR(7), repo: GADGETS });
    callDelayMs.set(REPO, 40);
    callDelayMs.set(GADGETS, 1);

    const [widgets, gadgets] = await Promise.all([
      loadPullRequests(query, { skipCache: false }),
      loadPullRequests({ ...query, repos: [GADGETS] }, { skipCache: true }),
    ]);

    expect(widgets.dataSource).toMatchObject({ githubRequests: 4, skippedCache: false });
    expect(gadgets.dataSource).toMatchObject({ githubRequests: 2, skippedCache: true });
    expect(widgets.dataSource.fetchDurationMs).toBeGreaterThanOrEqual(150);
    // gadgets finished long before widgets, so its time does not include widgets' calls.
    expect(gadgets.dataSource.fetchDurationMs).toBeLessThan(100);
  });

  test("a plain request joins a skipCache one in flight", async () => {
    setRemote(makePR(1));

    await Promise.all([
      loadPullRequests(query, { skipCache: true }),
      loadPullRequests(query, { skipCache: false }),
    ]);

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  test("a skipCache request does not join a plain one in flight", async () => {
    setRemote(makePR(1));

    const [plain, refresh] = await Promise.all([
      loadPullRequests(query, { skipCache: false }),
      loadPullRequests(query, { skipCache: true }),
    ]);

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(refresh).not.toBe(plain);
  });

  test("a failed load is shared, then forgotten", async () => {
    setRemote(makePR(1));
    listMock.mockImplementationOnce(() => Promise.reject(new Error("rate limited")));

    const results = await Promise.allSettled([
      loadPullRequests(query, { skipCache: false }),
      loadPullRequests(query, { skipCache: false }),
    ]);
    const retried = await loadPullRequests(query, { skipCache: false });

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(retried.fetchResult.prs).toEqual([makePR(1)]);
  });

  test("an older listing that finishes last does not replace the newer one", async () => {
    const pending: Array<(listing: PullRequestListing) => void> = [];
    const listing = (...numbers: number[]): PullRequestListing => ({
      prs: numbers.map((number) => ({ repo: REPO, number, updatedAt: makePR(number).updatedAt })),
      matchingPRs: numbers.length,
      isComplete: true,
      partialReasons: [],
    });
    const deferred = () =>
      new Promise<PullRequestListing>((resolve) => {
        pending.push(resolve);
      });
    listMock.mockImplementationOnce(deferred).mockImplementationOnce(deferred);
    setRemote(makePR(1), makePR(2));

    const plain = loadPullRequests(query, { skipCache: false });
    const refresh = loadPullRequests(query, { skipCache: true });
    while (pending.length < 2) await Bun.sleep(1);
    // The second listing started later, so it sees PR 2, created in between.
    pending[1](listing(1, 2));
    await Promise.race([plain, refresh]);
    pending[0](listing(1));
    await Promise.all([plain, refresh]);

    const cached = await readCache(buildListingCacheKey(query), cachedListingSchema);
    expect(cached?.value.prs.map((pr) => pr.number)).toEqual([1, 2]);
  });
});

describe("loadPullRequests progress", () => {
  function phases(progress: AnalysisProgress[]): string[] {
    return progress.map((snapshot) =>
      snapshot.phase === "fetching"
        ? `fetching ${snapshot.prsDone}/${snapshot.prsTotal}`
        : snapshot.phase,
    );
  }

  test("a request gets each step: listing cache, PR cache, then the fetch", async () => {
    setRemote(makePR(1), makePR(2));
    const progress: AnalysisProgress[] = [];

    await loadPullRequests(query, {
      skipCache: false,
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(phases(progress)).toEqual(["listing-cache", "pr-cache", "fetching 1/2", "fetching 2/2"]);
  });

  test("a request that joins a load gets its latest snapshot first, then the rest", async () => {
    setRemote(makePR(1));
    let releaseListing: () => void = () => {};
    const listingGate = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    listMock.mockImplementationOnce(async (listQuery, run) => {
      run.report({
        phase: "listing",
        repo: REPO,
        repoIndex: 0,
        repoCount: 1,
        listed: 0,
        matching: 1,
        page: 1,
        windowsDone: 0,
        windowsTotal: 1,
      });
      await listingGate;
      return {
        prs: [{ repo: REPO, number: 1, updatedAt: makePR(1).updatedAt }],
        matchingPRs: 1,
        ...listingExtras,
      };
    });
    const first = loadPullRequests(query, { skipCache: false });
    while (listMock.mock.calls.length === 0) await Bun.sleep(1);
    const joined: AnalysisProgress[] = [];

    const second = loadPullRequests(query, {
      skipCache: false,
      onProgress: (snapshot) => joined.push(snapshot),
    });
    releaseListing();
    await Promise.all([first, second]);

    expect(phases(joined)).toEqual(["listing", "pr-cache", "fetching 1/1"]);
  });

  test("an aborted request stops getting progress, but the load finishes and fills the cache", async () => {
    setRemote(makePR(1), makePR(2));
    const leaving = new AbortController();
    const progress: AnalysisProgress[] = [];

    const load = loadPullRequests(query, {
      skipCache: false,
      signal: leaving.signal,
      onProgress: (snapshot) => {
        progress.push(snapshot);
        if (snapshot.phase === "pr-cache") leaving.abort();
      },
    });
    const loaded = await load;

    expect(phases(progress)).toEqual(["listing-cache", "pr-cache"]);
    expect(loaded.fetchResult.prs).toEqual([makePR(1), makePR(2)]);
    expect(
      (await readCache(buildListingCacheKey(query), cachedListingSchema))?.value.prs,
    ).toHaveLength(2);
    expect(
      (await readCache(buildPullRequestCacheKey({ repo: REPO, number: 2 }), pullRequestSchema))
        ?.value,
    ).toEqual(makePR(2));
  });
});
