import { z } from "zod";
import type { Equals } from "../shared/type-equals.ts";
import type { DataSource } from "../shared/types.ts";
import { buildCacheKey, readCache, shortCacheKey, writeCache, type CacheHit } from "./cache.ts";
import { LISTING_NAMESPACE, PULL_REQUEST_NAMESPACE } from "./cache-namespaces.ts";
import {
  listPullRequests,
  type ListedPullRequest,
  type PullRequestListing,
} from "./github-listing.ts";
import { fetchPullRequestDetails } from "./github-pull-request-details.ts";
import { createGitHubRun, type GitHubRun } from "./github-run.ts";
import { startLoadRun, type LoadRun, type ProgressListener } from "./load-run.ts";
import { mapWithConcurrency } from "./lib/concurrency.ts";
import { uniqueReasons } from "./lib/partial-reasons.ts";
import { createLogger } from "./logger.ts";
import { pullRequestKey, type PullRequestRef } from "./pull-request-details.ts";
import { pullRequestSchema, type PullRequest } from "./pull-request-model.ts";

const log = createLogger("pull-requests");

const CACHE_IO_CONCURRENCY = 32;

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

// Fails to compile when the schema and CachedListing differ in any field.
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
  | { kind: "fresh"; pullRequest: PullRequest; cachedAt: string };

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
  cached: CacheHit<PullRequest> | null,
): PullRequestCacheLookup {
  if (!cached) return { kind: "missing" };
  if (cached.value.updatedAt !== listed.updatedAt) {
    return { kind: "stale", cachedUpdatedAt: cached.value.updatedAt };
  }
  return { kind: "fresh", pullRequest: cached.value, cachedAt: cached.cachedAt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The server is one process, so in-memory state is enough to order concurrent requests.
// Loads in flight, by mode and listing key, so identical concurrent requests share one.
const inFlightLoads = new Map<string, LoadRun<LoadedPullRequests>>();
// The last listing started per listing key. Only that one may write the listing entry, so a
// slower, older listing never replaces a newer one.
const latestListingIds = new Map<string, number>();
let nextListingId = 0;

// durationMs is the time spent listing on GitHub, 0 for a cache hit.
async function loadListing(
  query: PullRequestQuery,
  cacheKey: string,
  skipCache: boolean,
  run: GitHubRun,
): Promise<{ listing: CachedListing; source: DataSource["listing"]; durationMs: number }> {
  const shortKey = shortCacheKey(cacheKey);

  if (skipCache) {
    log.info(`Skipping listing cache read for key ${shortKey}`);
  } else {
    const cached = await readCache(cacheKey, cachedListingSchema);
    if (cached) {
      log.info(`Listing cache hit for key ${shortKey} (listed at ${cached.value.listedAt})`);
      return { listing: cached.value, source: "cache", durationMs: 0 };
    }
    log.info(`Listing cache miss for key ${shortKey}`);
  }

  const listingId = ++nextListingId;
  latestListingIds.set(cacheKey, listingId);
  const startedAt = performance.now();
  const listedAt = new Date().toISOString();
  const listing: CachedListing = { listedAt, ...(await listPullRequests(query, run)) };
  const durationMs = performance.now() - startedAt;
  if (latestListingIds.get(cacheKey) !== listingId) {
    log.info(`Not caching listing ${shortKey}: a newer listing for the same key started`);
    return { listing, source: "github", durationMs };
  }
  latestListingIds.delete(cacheKey);
  // Losing a listing to a cache write error would be worse than not caching it.
  try {
    await writeCache(cacheKey, listing, "listing");
  } catch (error: unknown) {
    log.warn(`Failed to write listing cache entry ${shortKey}: ${errorMessage(error)}`);
  }
  return { listing, source: "github", durationMs };
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
// A request joins an identical one in flight. A skipCache request lists from GitHub, so any
// request may join it; it never joins a plain one, which may serve the cached listing.
// onProgress gets the load's progress, the current snapshot first, until `signal` aborts;
// aborting only stops the progress, never the shared load.
export function loadPullRequests(
  query: PullRequestQuery,
  {
    skipCache,
    onProgress,
    signal,
  }: { skipCache: boolean; onProgress?: ProgressListener; signal?: AbortSignal },
): Promise<LoadedPullRequests> {
  const normalizedQuery = { ...query, repos: normalizeRepos(query.repos) };
  const cacheKey = buildListingCacheKey(normalizedQuery);
  const refreshKey = `refresh:${cacheKey}`;
  const loadKey = `load:${cacheKey}`;

  for (const key of skipCache ? [refreshKey] : [refreshKey, loadKey]) {
    const inFlight = inFlightLoads.get(key);
    if (inFlight) {
      log.info(`Joining the request in flight for key ${shortCacheKey(cacheKey)}`);
      if (onProgress) inFlight.subscribe(onProgress, signal);
      return inFlight.promise;
    }
  }

  const ownKey = skipCache ? refreshKey : loadKey;
  const load = startLoadRun({ phase: "listing-cache" }, (publish) =>
    loadPullRequestsNow(normalizedQuery, cacheKey, skipCache, publish).finally(() => {
      if (inFlightLoads.get(ownKey) === load) inFlightLoads.delete(ownKey);
    }),
  );
  inFlightLoads.set(ownKey, load);
  if (onProgress) load.subscribe(onProgress, signal);
  return load.promise;
}

async function loadPullRequestsNow(
  query: PullRequestQuery,
  cacheKey: string,
  skipCache: boolean,
  publish: ProgressListener,
): Promise<LoadedPullRequests> {
  // Requests that join this load share its run, so they report the same numbers.
  const run = createGitHubRun(publish);
  const {
    listing,
    source,
    durationMs: listingMs,
  } = await loadListing(query, cacheKey, skipCache, run);
  publish({ phase: "pr-cache", prs: listing.prs.length });

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

  const detailsStartedAt = performance.now();
  const fetched = await fetchPullRequestDetails(refsToFetch, run);
  const detailsMs = performance.now() - detailsStartedAt;

  const prs: PullRequest[] = [];
  const toStore: Array<{ ref: PullRequestRef; pullRequest: PullRequest }> = [];
  const detailReasons: string[] = [];
  let reusedPRs = 0;
  let fetchedPRs = 0;
  let oldestReusedCachedAt: string | null = null;
  listing.prs.forEach((listed, index) => {
    const lookup = lookups[index];
    if (lookup.kind === "fresh") {
      prs.push(lookup.pullRequest);
      reusedPRs++;
      if (oldestReusedCachedAt === null || isEarlier(lookup.cachedAt, oldestReusedCachedAt)) {
        oldestReusedCachedAt = lookup.cachedAt;
      }
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

  const dataSource: DataSource = {
    listing: source,
    listedAt: listing.listedAt,
    fetchedPRs,
    reusedPRs,
    oldestReusedCachedAt,
    githubRequests: run.requests,
    fetchDurationMs: run.requests > 0 ? Math.round(listingMs + detailsMs) : null,
    skippedCache: skipCache,
  };

  return {
    fetchResult: {
      prs,
      matchingPRs: listing.matchingPRs,
      analyzedPRs: prs.length,
      isComplete: listing.isComplete && detailReasons.length === 0,
      partialReasons: uniqueReasons([...listing.partialReasons, ...detailReasons]),
    },
    dataSource,
  };
}

// cachedAt values are ISO strings written by writeCache, but compare them as instants anyway.
function isEarlier(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}
