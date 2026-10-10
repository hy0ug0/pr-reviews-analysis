import type { PullRequest, ReviewMatrixCell } from "../../shared/types.ts";
import { isParticipant, toParticipantRules, type ParticipantOptions } from "./participants.ts";

// Who reviewed whose PRs: one cell per author and reviewer pair with at least one review.
// A review counts here exactly when analyze() counts it for the reviewer table: not
// DISMISSED or PENDING, submitted in the date range (or with no submission time), and by a
// participant. So a reviewer's cells add up to their totalReviews and prsReviewed, and all
// cells add up to totalReviews. A PR whose author GitHub can't resolve (a deleted account)
// gets a null author rather than losing its reviews.
//
// Expects the PRs analyze() counts, with excluded bot PRs already dropped.
export function summarizeReviewMatrix({
  prs,
  since,
  until,
  ...participantOptions
}: {
  prs: readonly PullRequest[];
  since?: string;
  until?: string;
} & ParticipantOptions): ReviewMatrixCell[] {
  const rules = toParticipantRules(participantOptions);
  const sinceISO = since || "";
  const untilISO = until ? until + "T23:59:59Z" : "";
  // Keyed by author, then reviewer, as GitHub spells them, like the reviewer table.
  const cellsByAuthor = new Map<string | null, Map<string, ReviewMatrixCell>>();

  for (const pr of prs) {
    const author = pr.author?.login ?? null;
    const reviewedBy = new Set<string>();

    for (const review of pr.reviews.nodes) {
      if (review.state === "DISMISSED" || review.state === "PENDING") continue;
      if (sinceISO && review.submittedAt && review.submittedAt < sinceISO) continue;
      if (untilISO && review.submittedAt && review.submittedAt > untilISO) continue;
      if (!isParticipant(review.author, pr, rules)) continue;
      const reviewer = review.author.login;

      const cells = cellsByAuthor.get(author) ?? new Map<string, ReviewMatrixCell>();
      cellsByAuthor.set(author, cells);
      const cell = cells.get(reviewer) ?? { author, reviewer, reviews: 0, prs: 0 };
      cells.set(reviewer, cell);
      cell.reviews++;
      if (!reviewedBy.has(reviewer)) {
        reviewedBy.add(reviewer);
        cell.prs++;
      }
    }
  }

  // Busiest pairs first, then by name, so the order doesn't depend on the PR order.
  return [...cellsByAuthor.values()]
    .flatMap((cells) => [...cells.values()])
    .sort(
      (a, b) =>
        b.reviews - a.reviews ||
        (a.author ?? "").localeCompare(b.author ?? "") ||
        a.reviewer.localeCompare(b.reviewer),
    );
}
