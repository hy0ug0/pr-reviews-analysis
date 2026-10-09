import { z } from "zod";
import type { DataSource, PullRequest } from "../shared/types.ts";
import { buildCacheKey, readCache, shortCacheKey, writeCache } from "./cache.ts";
import {
  fetchPullRequestDetails,
  listPullRequests,
  type ListedPullRequest,
  type PullRequestListing,
} from "./github.ts";
import { createLogger } from "./logger.ts";
import { pullRequestKey, type PullRequestRef } from "./pull-request-details.ts";
import { mapWithConcurrency, uniqueReasons } from "./review-pages.ts";

const log = createLogger("pull-requests");

// Bump the version whenever PullRequest, PRReview or CachedListing change shape,
// so entries written in the old shape are never read. Version 1 cached whole fetch results
// under "pull-requests-v1".
const CACHE_VERSION = 2;
const LISTING_NAMESPACE = `pull-request-listing-v${CACHE_VERSION}`;
const PULL_REQUEST_NAMESPACE = `pull-request-v${CACHE_VERSION}`;
const CACHE_IO_CONCURRENCY = 32;

const actorSchema = z.object({ login: z.string() }).nullable();

// The one schema for a PullRequest, used to validate PR cache entries.
export const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  author: actorSchema,
  reviews: z.object({
    nodes: z.array(
      z.object({
        author: actorSchema,
        state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
        submittedAt: z.string().nullable(),
        body: z.string(),
      }),
    ),
  }),
});

export const cachedListingSchema = z.object({
  listedAt: z.string(),
  prs: z.array(z.object({ repo: z.string(), number: z.number(), updatedAt: z.string() })),
  matchingPRs: z.number(),
  isComplete: z.boolean(),
  partialReasons: z.array(z.string()),
});

export interface CachedListing extends PullRequestListing {
  listedAt: string;
}

// Fails to compile when a schema and its type differ in any field, including optional ones
// that zod would otherwise strip on read.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
true satisfies Equals<z.infer<typeof pullRequestSchema>, PullRequest>;
true satisfies Equals<z.infer<typeof cachedListingSchema>, CachedListing>;

export interface PullRequestQuery {
  repos: string[];
  label?: string;
  since?: string;
  until?: string;
}

export interface PullRequestFetchResult {
  prs: PullRequest[];
  matchingPRs: number;
  analyzedPRs: number;
  isComplete: boolean;
  partialReasons: string[];
}

export interface LoadedPullRequests {
  fetchResult: PullRequestFetchResult;
  dataSource: DataSource;
}

// What the PR cache holds for a listed PR. "stale": cached, but GitHub reports a different
// updatedAt, so the PR changed since it was cached.
export type PullRequestCacheLookup =
  | { kind: "missing" }
  | { kind: "stale"; cachedUpdatedAt: string }
  | { kind: "fresh"; pullRequest: PullRequest };

// GitHub repository names are case-insensitive, so "Acme/Widgets,acme/widgets" and
// "acme/widgets" name the same data and share one cache entry.
export function normalizeRepos(repos: string[]): string[] {
  const unique = new Set(repos.map((repo) => repo.trim().toLowerCase()).filter(Boolean));
  return Array.from(unique).sort();
}

// The team list is not part of the key because analyze() applies the team filter on every
// request.
export function buildListingCacheKey(query: PullRequestQuery): string {
  return buildCacheKey(LISTING_NAMESPACE, {
    repos: normalizeRepos(query.repos),
    label: query.label ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
  });
}

// One entry per PR, shared by every query whose listing includes it.
export function buildPullRequestCacheKey(ref: PullRequestRef): string {
  return buildCacheKey(PULL_REQUEST_NAMESPACE, pullRequestKey(ref));
}

export function classifyCachedPullRequest(
  listed: ListedPullRequest,
  cached: PullRequest | null,
): PullRequestCacheLookup {
  if (!cached) return { kind: "missing" };
  if (cached.updatedAt !== listed.updatedAt) {
    return { kind: "stale", cachedUpdatedAt: cached.updatedAt };
  }
  return { kind: "fresh", pullRequest: cached };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadListing(
  query: PullRequestQuery,
  skipCache: boolean,
): Promise<{ listing: CachedListing; source: DataSource["listing"] }> {
  const cacheKey = buildListingCacheKey(query);
  const shortKey = shortCacheKey(cacheKey);

  if (skipCache) {
    log.info(`Skipping listing cache read for key ${shortKey}`);
  } else {
    const cached = await readCache(cacheKey, cachedListingSchema);
    if (cached) {
      log.info(`Listing cache hit for key ${shortKey} (listed at ${cached.listedAt})`);
      return { listing: cached, source: "cache" };
    }
    log.info(`Listing cache miss for key ${shortKey}`);
  }

  const listedAt = new Date().toISOString();
  const listing: CachedListing = { listedAt, ...(await listPullRequests(query)) };
  // Losing a listing to a cache write error would be worse than not caching it.
  try {
    await writeCache(cacheKey, listing, "listing");
  } catch (error: unknown) {
    log.warn(`Failed to write listing cache entry ${shortKey}: ${errorMessage(error)}`);
  }
  return { listing, source: "github" };
}

async function storePullRequests(
  entries: Array<{ ref: PullRequestRef; pullRequest: PullRequest }>,
) {
  let failures = 0;
  await mapWithConcurrency(entries, CACHE_IO_CONCURRENCY, async ({ ref, pullRequest }) => {
    try {
      await writeCache(buildPullRequestCacheKey(ref), pullRequest, "pullRequest");
    } catch (error: unknown) {
      failures++;
      if (failures === 1) {
        log.warn(`Failed to write PR cache entry ${pullRequestKey(ref)}: ${errorMessage(error)}`);
      }
    }
    // mapWithConcurrency rejects undefined results.
    return true;
  });
  if (failures > 1) log.warn(`Failed to write ${failures} PR cache entries`);
}

// Lists the query's PRs (from the listing cache unless skipCache), reuses every PR whose
// cached updatedAt matches the listing, and fetches only the others from GitHub.
export async function loadPullRequests(
  query: PullRequestQuery,
  { skipCache }: { skipCache: boolean },
): Promise<LoadedPullRequests> {
  const repos = normalizeRepos(query.repos);
  const { listing, source } = await loadListing({ ...query, repos }, skipCache);

  const lookups = await mapWithConcurrency(
    listing.prs,
    CACHE_IO_CONCURRENCY,
    async (listed): Promise<PullRequestCacheLookup> =>
      classifyCachedPullRequest(
        listed,
        await readCache(buildPullRequestCacheKey(listed), pullRequestSchema),
      ),
  );

  const refsToFetch: PullRequestRef[] = [];
  let missing = 0;
  let stale = 0;
  listing.prs.forEach(({ repo, number }, index) => {
    const lookup = lookups[index];
    if (lookup.kind === "fresh") return;
    if (lookup.kind === "missing") missing++;
    else stale++;
    refsToFetch.push({ repo, number });
  });
  log.info(
    `${listing.prs.length - refsToFetch.length}/${listing.prs.length} PRs reused from cache; fetching ${refsToFetch.length} (${missing} not cached, ${stale} updated)`,
  );

  const fetched = await fetchPullRequestDetails(refsToFetch);

  const prs: PullRequest[] = [];
  const toStore: Array<{ ref: PullRequestRef; pullRequest: PullRequest }> = [];
  const detailReasons: string[] = [];
  let reusedPRs = 0;
  let fetchedPRs = 0;
  listing.prs.forEach((listed, index) => {
    const lookup = lookups[index];
    if (lookup.kind === "fresh") {
      prs.push(lookup.pullRequest);
      reusedPRs++;
      return;
    }

    const ref = { repo: listed.repo, number: listed.number };
    const result = fetched.get(pullRequestKey(ref));
    if (!result) {
      detailReasons.push(`Pull request ${pullRequestKey(ref)} was not fetched.`);
      return;
    }
    switch (result.kind) {
      case "complete":
        prs.push(result.pullRequest);
        toStore.push({ ref, pullRequest: result.pullRequest });
        fetchedPRs++;
        break;
      case "partial":
        // Served once, never cached: the next request fetches it again.
        prs.push(result.pullRequest);
        detailReasons.push(result.reason);
        fetchedPRs++;
        break;
      case "failed":
        detailReasons.push(result.reason);
        break;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  });

  await storePullRequests(toStore);

  return {
    fetchResult: {
      prs,
      matchingPRs: listing.matchingPRs,
      analyzedPRs: prs.length,
      isComplete: listing.isComplete && detailReasons.length === 0,
      partialReasons: uniqueReasons([...listing.partialReasons, ...detailReasons]),
    },
    dataSource: { listing: source, listedAt: listing.listedAt, fetchedPRs, reusedPRs },
  };
}
