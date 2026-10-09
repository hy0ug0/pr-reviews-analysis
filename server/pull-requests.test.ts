import { afterAll, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisResult } from "../shared/types.ts";
import type { PullRequestFetchResult } from "./github.ts";

// cache.ts reads CACHE_DIR once at load time, so set it before importing.
const cacheDir = await mkdtemp(join(tmpdir(), "pr-reviews-analysis-test-"));
process.env.CACHE_DIR = cacheDir;
const { getCacheConfig, readCache, writeCache } = await import("./cache.ts");
const { buildPullRequestsCacheKey, normalizeRepos, pullRequestFetchResultSchema } =
  await import("./pull-requests.ts");

if (getCacheConfig().cacheDir !== cacheDir) {
  throw new Error("cache.ts was loaded before CACHE_DIR was set");
}

afterAll(() => rm(cacheDir, { recursive: true, force: true }));

function makeFetchResult(): PullRequestFetchResult {
  return {
    prs: [
      {
        number: 1,
        title: "Widget change #1",
        state: "MERGED",
        url: "https://github.com/acme/widgets/pull/1",
        createdAt: "2026-03-01T09:00:00Z",
        mergedAt: "2026-03-20T09:00:00Z",
        closedAt: "2026-03-20T09:00:00Z",
        author: { login: "alice" },
        reviews: {
          nodes: [
            {
              author: { login: "bob" },
              state: "APPROVED",
              submittedAt: "2026-03-15T12:00:00Z",
              body: "",
            },
          ],
        },
      },
    ],
    matchingPRs: 2,
    analyzedPRs: 1,
    isComplete: false,
    partialReasons: ["Failed to fetch complete reviews for acme/widgets#2: timeout"],
  };
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

describe("pull request cache key", () => {
  test("ignores repo order, case, whitespace and duplicates", () => {
    const key = buildPullRequestsCacheKey({ repos: ["acme/widgets", "acme/gadgets"] });
    const variant = buildPullRequestsCacheKey({
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

  test("changes when the label or date range changes", () => {
    const repos = ["acme/widgets"];
    const keys = new Set([
      buildPullRequestsCacheKey({ repos }),
      buildPullRequestsCacheKey({ repos, label: "bug" }),
      buildPullRequestsCacheKey({ repos, since: "2026-03-01" }),
      buildPullRequestsCacheKey({ repos, until: "2026-03-31" }),
    ]);

    expect(keys.size).toBe(4);
  });

  test("starts with the namespace and version", () => {
    expect(buildPullRequestsCacheKey({ repos: ["acme/widgets"] })).toMatch(
      /^pull-requests-v1-[0-9a-f]{64}$/,
    );
  });
});

describe("cached pull request validation", () => {
  test("returns a stored fetch result, including partial fetch details", async () => {
    const key = buildPullRequestsCacheKey({ repos: ["acme/widgets"], label: "valid" });
    await writeCache(key, makeFetchResult());

    expect(await readCache(key, pullRequestFetchResultSchema)).toEqual(makeFetchResult());
  });

  test("deletes an entry whose value does not match the schema", async () => {
    const key = buildPullRequestsCacheKey({ repos: ["acme/widgets"], label: "wrong-shape" });
    const fetchResult = makeFetchResult();
    await writeCache(key, { ...fetchResult, prs: [{ ...fetchResult.prs[0], reviews: "oops" }] });

    expect(await readCache(key, pullRequestFetchResultSchema)).toBeNull();
    expect(await fileExists(cacheFilePath(key))).toBe(false);
  });

  test("rejects an analysis result stored under a fetch result key", async () => {
    const key = buildPullRequestsCacheKey({ repos: ["acme/widgets"], label: "analysis" });
    const analysisResult: AnalysisResult = {
      matchingPRs: 1,
      analyzedPRs: 1,
      isComplete: true,
      partialReasons: [],
      totalReviews: 1,
      uniqueReviewers: 1,
      avgReviewsPerPR: 1,
      reviewerStats: [],
      timeRange: { since: "", until: "" },
    };
    await writeCache(key, analysisResult);

    expect(await readCache(key, pullRequestFetchResultSchema)).toBeNull();
    expect(await fileExists(cacheFilePath(key))).toBe(false);
  });

  test("deletes an entry that is not valid JSON", async () => {
    const key = buildPullRequestsCacheKey({ repos: ["acme/widgets"], label: "not-json" });
    await writeFile(cacheFilePath(key), "not json{", "utf8");

    expect(await readCache(key, pullRequestFetchResultSchema)).toBeNull();
    expect(await fileExists(cacheFilePath(key))).toBe(false);
  });
});
