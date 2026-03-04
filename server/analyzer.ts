import type { PullRequest, AnalyzeParams, AnalysisResult, ReviewerStats } from "../shared/types.ts";

export function analyze(prs: PullRequest[], params: AnalyzeParams): AnalysisResult {
  const reviewerMap = new Map<string, ReviewerStats>();
  const teamSet = params.teamMembers?.length ? new Set(params.teamMembers) : null;

  let totalReviews = 0;
  const sinceISO = params.since || "";
  const untilISO = params.until ? params.until + "T23:59:59Z" : "";

  for (const pr of prs) {
    const prAuthor = pr.author?.login;
    const reviewedBy = new Set<string>();

    for (const review of pr.reviews.nodes) {
      const reviewer = review.author?.login;
      if (!reviewer) continue;
      if (reviewer === prAuthor) continue;
      if (teamSet && !teamSet.has(reviewer)) continue;
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
    matchingPRs: prs.length,
    analyzedPRs: prs.length,
    isComplete: true,
    partialReasons: [],
    totalReviews,
    uniqueReviewers: reviewerStats.length,
    avgReviewsPerPR: prs.length > 0 ? Math.round((totalReviews / prs.length) * 10) / 10 : 0,
    reviewerStats,
    timeRange: {
      since: params.since || "",
      until: params.until || "",
    },
  };
}
