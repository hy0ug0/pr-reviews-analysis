import { z } from "zod";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export const timeRangePresets = ["week", "month", "quarter", "year", "all", "custom"] as const;

export const analyzeFormSchema = z.object({
  repo: z
    .string()
    .trim()
    .min(1, "At least one repository is required")
    .refine(
      (val) =>
        val
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
          .every((r) => REPO_PATTERN.test(r)),
      "Each repository must match the owner/repo format",
    ),
  label: z.string().trim().optional().default(""),
  timeRange: z.enum(timeRangePresets).default("month"),
  since: z.string().optional().default(""),
  until: z.string().optional().default(""),
  team: z.string().trim().optional().default(""),
  skipCache: z.boolean().optional().default(false),
});

export type AnalyzeFormInput = z.input<typeof analyzeFormSchema>;

export const analyzeQuerySchema = z.object({
  repo: z
    .string()
    .trim()
    .min(1, "At least one repository is required")
    .refine(
      (val) =>
        val
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
          .every((r) => REPO_PATTERN.test(r)),
      "Each repository must match the owner/repo format",
    ),
  label: z.string().trim().optional(),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  team: z.string().trim().optional(),
  skipCache: z
    .string()
    .optional()
    .transform((v) => v === "1"),
});

export const reviewerStatsSchema = z.object({
  login: z.string(),
  totalReviews: z.number(),
  approvals: z.number(),
  changesRequested: z.number(),
  comments: z.number(),
  prsReviewed: z.number(),
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
  timeRange: z.object({ since: z.string(), until: z.string() }),
});
