import type {
  PullRequest,
  AnalyzeParams,
  AnalysisMetrics,
  ReviewerStats,
} from "../../shared/types.ts";
import { summarizeFirstResponse } from "./first-response.ts";
import { isParticipant, toParticipantRules } from "./participants.ts";

export function analyze(prs: PullRequest[], params: AnalyzeParams): AnalysisMetrics {
  const reviewerMap = new Map<string, ReviewerStats>();
  const rules = toParticipantRules(params);

  let totalReviews = 0;
  const sinceISO = params.since || "";
  const untilISO = params.until ? params.until + "T23:59:59Z" : "";

  for (const pr of prs) {
    const reviewedBy = new Set<string>();

    for (const review of pr.reviews.nodes) {
      if (!isParticipant(review.author, pr, rules)) continue;
      const reviewer = review.author.login;
      if (review.state === "DISMISSED" || review.state === "PENDING") continue;
      if (sinceISO && review.submittedAt && review.submittedAt < sinceISO) continue;
      if (untilISO && review.submittedAt && review.submittedAt > untilISO) continue;

      if (!reviewerMap.has(reviewer)) {
        reviewerMap.set(reviewer, {
          login: reviewer,
          totalReviews: 0,
          approvals: 0,
          changesRequested: 0,
          comments: 0,
          prsReviewed: 0,
        });
      }

      const stats = reviewerMap.get(reviewer)!;
      stats.totalReviews++;
      totalReviews++;

      switch (review.state) {
        case "APPROVED":
          stats.approvals++;
          break;
        case "CHANGES_REQUESTED":
          stats.changesRequested++;
          break;
        case "COMMENTED":
          stats.comments++;
          break;
      }

      reviewedBy.add(reviewer);
    }

    for (const reviewer of reviewedBy) {
      reviewerMap.get(reviewer)!.prsReviewed++;
    }
  }

  const reviewerStats = Array.from(reviewerMap.values()).sort(
    (a, b) => b.totalReviews - a.totalReviews,
  );

  return {
    totalReviews,
    uniqueReviewers: reviewerStats.length,
    avgReviewsPerPR: prs.length > 0 ? Math.round((totalReviews / prs.length) * 10) / 10 : 0,
    reviewerStats,
    firstResponse: summarizeFirstResponse({
      prs,
      teamMembers: params.teamMembers,
      since: params.since,
      until: params.until,
    }),
    timeRange: {
      since: params.since || "",
      until: params.until || "",
    },
  };
}
