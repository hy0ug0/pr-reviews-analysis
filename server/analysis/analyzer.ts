import type {
  PullRequest,
  AnalyzeParams,
  AnalysisMetrics,
  ReviewerStats,
} from "../../shared/types.ts";
import { summarizeFirstResponse } from "./first-response.ts";
import {
  isExcludedBotPR,
  isParticipant,
  toParticipantRules,
  type ParticipantOptions,
} from "./participants.ts";

// The request parameters plus the server settings the analysis applies.
export type AnalyzeOptions = AnalyzeParams & Pick<ParticipantOptions, "botLogins">;

export function analyze(loadedPRs: PullRequest[], options: AnalyzeOptions): AnalysisMetrics {
  const reviewerMap = new Map<string, ReviewerStats>();
  const rules = toParticipantRules(options);
  // Dropped before any metric, so bot PRs count toward no total, average or response time.
  const prs = loadedPRs.filter((pr) => !isExcludedBotPR(pr, rules));
  // With bots excluded, a review these rules accept was skipped only for being by a bot.
  const rulesWithBots = rules.includeBots ? null : { ...rules, includeBots: true };

  let totalReviews = 0;
  let excludedBotReviews = 0;
  const sinceISO = options.since || "";
  const untilISO = options.until ? options.until + "T23:59:59Z" : "";

  for (const pr of prs) {
    const reviewedBy = new Set<string>();

    for (const review of pr.reviews.nodes) {
      if (review.state === "DISMISSED" || review.state === "PENDING") continue;
      if (sinceISO && review.submittedAt && review.submittedAt < sinceISO) continue;
      if (untilISO && review.submittedAt && review.submittedAt > untilISO) continue;
      if (!isParticipant(review.author, pr, rules)) {
        if (rulesWithBots && isParticipant(review.author, pr, rulesWithBots)) excludedBotReviews++;
        continue;
      }
      const reviewer = review.author.login;

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
    excludedBots: rulesWithBots
      ? { prs: loadedPRs.length - prs.length, reviews: excludedBotReviews }
      : null,
    totalReviews,
    uniqueReviewers: reviewerStats.length,
    avgReviewsPerPR: prs.length > 0 ? Math.round((totalReviews / prs.length) * 10) / 10 : 0,
    reviewerStats,
    firstResponse: summarizeFirstResponse({
      prs,
      teamMembers: options.teamMembers,
      includeBots: options.includeBots,
      botLogins: options.botLogins,
      since: options.since,
      until: options.until,
    }),
    timeRange: {
      since: options.since || "",
      until: options.until || "",
    },
  };
}
