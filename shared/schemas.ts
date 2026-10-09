import { z } from "zod";
import type { Equals } from "./type-equals";
import type { AnalysisResult } from "./types";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

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
  .refine(
    (repos) => repos.every((repo) => REPO_PATTERN.test(repo)),
    "Each repository must match the owner/repo format",
  );

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

export const analyzeFormSchema = z.object({
  repo: repoListSchema,
  label: z.string().trim().optional().default(""),
  timeRange: z.enum(timeRangePresets).default("month"),
  since: z.string().optional().default(""),
  until: z.string().optional().default(""),
  team: z.string().trim().optional().default(""),
  skipCache: z.boolean().optional().default(false),
});

export type AnalyzeFormInput = z.input<typeof analyzeFormSchema>;

// The parameter keeps the form's field name, `repo`; the output calls the list `repos`.
export const analyzeQuerySchema = z
  .object({
    repo: repoListSchema,
    label: z.string().optional().transform(emptyAsUndefined),
    since: optionalDateSchema,
    until: optionalDateSchema,
    team: z.string().optional().transform(parseList),
    skipCache: z
      .string()
      .optional()
      .transform((v) => v === "1"),
  })
  // YYYY-MM-DD strings sort like the dates they spell.
  .refine((query) => !query.since || !query.until || query.since <= query.until, {
    path: ["since"],
    message: "Must be on or before until",
  })
  .transform(({ repo, ...rest }) => ({ ...rest, repos: repo }));

export const reviewerStatsSchema = z.object({
  login: z.string(),
  totalReviews: z.number(),
  approvals: z.number(),
  changesRequested: z.number(),
  comments: z.number(),
  prsReviewed: z.number(),
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

export const dataSourceSchema = z.object({
  listing: z.enum(["cache", "github"]),
  listedAt: z.string(),
  fetchedPRs: z.number(),
  reusedPRs: z.number(),
});

export const analysisResultSchema = z.object({
  matchingPRs: z.number(),
  analyzedPRs: z.number(),
  isComplete: z.boolean(),
  partialReasons: z.array(z.string()),
  totalReviews: z.number(),
  uniqueReviewers: z.number(),
  avgReviewsPerPR: z.number(),
  reviewerStats: z.array(reviewerStatsSchema),
  firstResponse: firstResponseSummarySchema,
  timeRange: z.object({ since: z.string(), until: z.string() }),
  dataSource: dataSourceSchema.optional(),
});

// Fails to compile when the schema and AnalysisResult differ in any field, so the
// client never strips or rejects a field the server sends.
true satisfies Equals<z.infer<typeof analysisResultSchema>, AnalysisResult>;
