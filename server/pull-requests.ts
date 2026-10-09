import { z } from "zod";
import { buildCacheKey, readCache, shortCacheKey, writeCache } from "./cache.ts";
import { fetchPullRequests, type PullRequestFetchResult } from "./github.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("pull-requests");

// Bump the version whenever PullRequest, PRReview or PullRequestFetchResult change shape,
// so entries written in the old shape are never read.
const CACHE_VERSION = 1;
const CACHE_NAMESPACE = `pull-requests-v${CACHE_VERSION}`;

const actorSchema = z.object({ login: z.string() }).nullable();

export const pullRequestFetchResultSchema = z.object({
  prs: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      url: z.string(),
      createdAt: z.string(),
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
    }),
  ),
  matchingPRs: z.number(),
  analyzedPRs: z.number(),
  isComplete: z.boolean(),
  partialReasons: z.array(z.string()),
});

// Fails to compile when the schema and PullRequestFetchResult differ in any field,
// including optional ones that zod would otherwise strip on read.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
true satisfies Equals<z.infer<typeof pullRequestFetchResultSchema>, PullRequestFetchResult>;

export interface PullRequestQuery {
  repos: string[];
  label?: string;
  since?: string;
  until?: string;
}

export interface LoadedPullRequests {
  fetchResult: PullRequestFetchResult;
  cacheHit: boolean;
}

// GitHub repository names are case-insensitive, so "Acme/Widgets,acme/widgets" and
// "acme/widgets" name the same data and share one cache entry.
export function normalizeRepos(repos: string[]): string[] {
  const unique = new Set(repos.map((repo) => repo.trim().toLowerCase()).filter(Boolean));
  return Array.from(unique).sort();
}

// The team list is not part of the key because analyze() applies the team filter on every
// request.
export function buildPullRequestsCacheKey(query: PullRequestQuery): string {
  return buildCacheKey(CACHE_NAMESPACE, {
    repos: normalizeRepos(query.repos),
    label: query.label ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
  });
}

// The fetch uses the same normalized repo list as the key.
export async function loadPullRequests(
  query: PullRequestQuery,
  { skipCache }: { skipCache: boolean },
): Promise<LoadedPullRequests> {
  const repos = normalizeRepos(query.repos);
  const cacheKey = buildPullRequestsCacheKey({ ...query, repos });

  const shortKey = shortCacheKey(cacheKey);

  if (skipCache) {
    log.info(`Skipping cache read for key ${shortKey}`);
  } else {
    const cached = await readCache(cacheKey, pullRequestFetchResultSchema);
    if (cached) {
      log.info(`Cache hit for key ${shortKey}`);
      return { fetchResult: cached, cacheHit: true };
    }
    log.info(`Cache miss for key ${shortKey}`);
  }

  const fetchResult = await fetchPullRequests(repos, query.label, query.since, query.until);
  // A fetch can take minutes; losing it to a cache write error would be worse than not caching.
  try {
    await writeCache(cacheKey, fetchResult);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to write cache entry ${shortKey}: ${message}`);
  }
  return { fetchResult, cacheHit: false };
}
