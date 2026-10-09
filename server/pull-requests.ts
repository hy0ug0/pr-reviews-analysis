import { z } from "zod";
import type { AnalyzeParams } from "../shared/types.ts";
import { buildCacheKey, readCache, writeCache } from "./cache.ts";
import { fetchPullRequests, type PullRequestFetchResult } from "./github.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("pull-requests");

// Bump the version whenever PullRequest, PRReview or PullRequestFetchResult change shape.
// The schema type annotation catches added fields at compile time, but not removed ones.
const CACHE_VERSION = 1;
const CACHE_NAMESPACE = `pull-requests-v${CACHE_VERSION}`;

const actorSchema = z.object({ login: z.string() }).nullable();

export const pullRequestFetchResultSchema: z.ZodType<PullRequestFetchResult> = z.object({
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

export type PullRequestQuery = Omit<AnalyzeParams, "teamMembers">;

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

  if (skipCache) {
    log.info(`Skipping cache read for key ${cacheKey}`);
  } else {
    const cached = await readCache(cacheKey, pullRequestFetchResultSchema);
    if (cached) {
      log.info(`Cache hit for key ${cacheKey}`);
      return { fetchResult: cached, cacheHit: true };
    }
    log.info(`Cache miss for key ${cacheKey}`);
  }

  const fetchResult = await fetchPullRequests(repos, query.label, query.since, query.until);
  await writeCache(cacheKey, fetchResult);
  return { fetchResult, cacheHit: false };
}
