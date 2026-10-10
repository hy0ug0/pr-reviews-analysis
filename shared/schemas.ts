import { z } from "zod";
import type { Equals } from "./type-equals";
import type { AnalysisMetrics, AnalysisProgress, AnalysisResult } from "./types";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

// GitHub launched in 2008, so no PR is older. A search with no since starts here.
export const GITHUB_EPOCH_DATE = "2008-01-01";

// A search with no until ends today, in UTC like GitHub's created: qualifier.
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isRepoName(value: string): boolean {
  return REPO_PATTERN.test(value);
}

export const timeRangePresets = ["week", "month", "quarter", "year", "all", "custom"] as const;

// Repositories and team members travel as comma-separated lists; blank entries are dropped.
export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const repoListSchema = z
  .string({ error: "At least one repository is required" })
  .transform(parseList)
  .refine((repos) => repos.length > 0, "At least one repository is required")
  .refine((repos) => repos.every(isRepoName), "Each repository must match the owner/repo format");

// A query string can't leave a value unset, so an empty value means the same as a missing one.
function emptyAsUndefined(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

const optionalDateSchema = z
  .string()
  .optional()
  .transform(emptyAsUndefined)
  .pipe(
    z.iso
      .date({ error: (issue) => `Invalid date ${String(issue.input)}, expected YYYY-MM-DD` })
      .optional(),
  );

// Checks a range against the bounds a search actually uses: GitHub's epoch when since is
// missing and today when until is missing. YYYY-MM-DD strings sort like the dates they spell.
function checkDateRange(
  { since, until }: { since?: string; until?: string },
  ctx: z.RefinementCtx,
): void {
  if (until && until < GITHUB_EPOCH_DATE) {
    ctx.addIssue({
      code: "custom",
      path: ["until"],
      message: `Must be on or after ${GITHUB_EPOCH_DATE}`,
    });
  }
  if (since && until) {
    if (since > until) {
      ctx.addIssue({ code: "custom", path: ["since"], message: "Must be on or before until" });
    }
  } else if (since && since > todayUtc()) {
    ctx.addIssue({ code: "custom", path: ["since"], message: "Must be on or before today" });
  }
}

export const analyzeFormSchema = z
  .object({
    repo: repoListSchema,
    label: z.string().trim().optional().default(""),
    timeRange: z.enum(timeRangePresets).default("month"),
    since: z.string().optional().default(""),
    until: z.string().optional().default(""),
    team: z.string().trim().optional().default(""),
    skipCache: z.boolean().optional().default(false),
    includeBots: z.boolean().optional().default(false),
  })
  // Presets compute their own range; only a custom one comes from the user.
  .superRefine((form, ctx) => {
    if (form.timeRange !== "custom") return;
    checkDateRange({ since: form.since || undefined, until: form.until || undefined }, ctx);
  });

export type AnalyzeFormInput = z.input<typeof analyzeFormSchema>;

// Flags travel as 1; any other value or none means off.
const flagSchema = z
  .string()
  .optional()
  .transform((v) => v === "1");

// The parameter keeps the form's field name, `repo`; the output calls the list `repos`.
export const analyzeQuerySchema = z
  .object({
    repo: repoListSchema,
    label: z.string().optional().transform(emptyAsUndefined),
    since: optionalDateSchema,
    until: optionalDateSchema,
    team: z.string().optional().transform(parseList),
    skipCache: flagSchema,
    // Applied after the cache, so it is not part of any cache key.
    includeBots: flagSchema,
  })
  .superRefine(checkDateRange)
  .transform(({ repo, ...rest }) => ({ ...rest, repos: repo }));

export const reviewerStatsSchema = z.object({
  login: z.string(),
  totalReviews: z.number(),
  approvals: z.number(),
  changesRequested: z.number(),
  comments: z.number(),
  prsReviewed: z.number(),
  responseP50Ms: z.number().nullable(),
  responseP90Ms: z.number().nullable(),
  responseSamples: z.number(),
});

export const firstResponseSummarySchema = z.object({
  respondedPRs: z.number(),
  waitingPRs: z.number(),
  closedWithoutResponsePRs: z.number(),
  draftPRs: z.number(),
  undeterminedPRs: z.number(),
  p50Ms: z.number().nullable(),
  p75Ms: z.number().nullable(),
  p90Ms: z.number().nullable(),
  histogram: z.array(
    z.object({
      label: z.string(),
      minMs: z.number(),
      maxMs: z.number().nullable(),
      count: z.number(),
    }),
  ),
  weekly: z.array(
    z.object({
      weekStart: z.string(),
      p50Ms: z.number().nullable(),
      count: z.number(),
    }),
  ),
});

const durationBucketsSchema = z.array(
  z.object({
    label: z.string(),
    minMs: z.number(),
    maxMs: z.number().nullable(),
    count: z.number(),
  }),
);

export const reviewCycleSummarySchema = z.object({
  timeToMerge: z.object({
    mergedPRs: z.number(),
    openPRs: z.number(),
    closedUnmergedPRs: z.number(),
    p50Ms: z.number().nullable(),
    p90Ms: z.number().nullable(),
    histogram: durationBucketsSchema,
  }),
  timeToApproval: z.object({
    approvedPRs: z.number(),
    approvedAtFirstReviewPRs: z.number(),
    notApprovedPRs: z.number(),
    unreviewedPRs: z.number(),
    draftPRs: z.number(),
    undeterminedPRs: z.number(),
    p50Ms: z.number().nullable(),
    p90Ms: z.number().nullable(),
    histogram: durationBucketsSchema,
  }),
  reviewRounds: z.object({
    reviewedMergedPRs: z.number(),
    mergedWithoutReviewPRs: z.number(),
    undeterminedPRs: z.number(),
    p50: z.number().nullable(),
    p90: z.number().nullable(),
    distribution: z.array(
      z.object({
        label: z.string(),
        rounds: z.number(),
        orMore: z.boolean(),
        count: z.number(),
      }),
    ),
  }),
});

export const dataSourceSchema = z.object({
  listing: z.enum(["cache", "github"]),
  listedAt: z.string(),
  fetchedPRs: z.number(),
  reusedPRs: z.number(),
  oldestReusedCachedAt: z.string().nullable(),
  githubRequests: z.number(),
  fetchDurationMs: z.number().nullable(),
  skippedCache: z.boolean(),
});

// Every field but byRepo, which repeats the metrics part for each repo.
const analysisFieldsSchema = z.object({
  countedPRs: z.number(),
  excludedBots: z.object({ prs: z.number(), reviews: z.number() }).nullable(),
  matchingPRs: z.number(),
  analyzedPRs: z.number(),
  isComplete: z.boolean(),
  partialReasons: z.array(z.string()),
  totalReviews: z.number(),
  uniqueReviewers: z.number(),
  avgReviewsPerPR: z.number(),
  reviewerStats: z.array(reviewerStatsSchema),
  firstResponse: firstResponseSummarySchema,
  reviewCycle: reviewCycleSummarySchema,
  timeRange: z.object({ since: z.string(), until: z.string() }),
  dataSource: dataSourceSchema.optional(),
});

// The metrics are what is left without the coverage and the data source, so a metric added
// above is checked in each byRepo entry too.
const analysisMetricsSchema = analysisFieldsSchema.omit({
  matchingPRs: true,
  analyzedPRs: true,
  isComplete: true,
  partialReasons: true,
  dataSource: true,
});

export const analysisResultSchema = analysisFieldsSchema.extend({
  byRepo: z.array(z.object({ repo: z.string(), metrics: analysisMetricsSchema })),
});

// Fail to compile when a schema and its type differ in any field, so the client never
// strips or rejects a field the server sends.
true satisfies Equals<z.infer<typeof analysisMetricsSchema>, AnalysisMetrics>;
true satisfies Equals<z.infer<typeof analysisResultSchema>, AnalysisResult>;

const rateLimitedUntilSchema = z.iso.datetime().optional();

export const analysisProgressSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("listing-cache") }),
  z.object({
    phase: z.literal("listing"),
    repos: z.array(
      z.object({
        repo: z.string(),
        listed: z.number(),
        matching: z.number().nullable(),
        page: z.number(),
        windowsDone: z.number(),
        windowsTotal: z.number(),
      }),
    ),
    rateLimitedUntil: rateLimitedUntilSchema,
  }),
  z.object({ phase: z.literal("pr-cache"), prs: z.number() }),
  z.object({
    phase: z.literal("fetching"),
    repos: z.array(
      z.object({
        repo: z.string(),
        prsDone: z.number(),
        prsTotal: z.number(),
        batchesDone: z.number(),
        batchesTotal: z.number(),
        reviewPRsDone: z.number(),
        reviewPRsTotal: z.number().nullable(),
      }),
    ),
    rateLimitedUntil: rateLimitedUntilSchema,
  }),
  z.object({ phase: z.literal("analyzing"), prs: z.number() }),
]);

true satisfies Equals<z.infer<typeof analysisProgressSchema>, AnalysisProgress>;
