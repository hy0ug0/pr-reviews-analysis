import type { FirstResponseSummary, PullRequest } from "../../shared/types.ts";
import {
  isParticipant,
  toParticipantRules,
  type ParticipantOptions,
  type ParticipantRules,
} from "./participants.ts";
import { buildHistogram, buildWeekly, roundedPercentile } from "./stats.ts";

// Times are epoch milliseconds.
export type FirstResponseOutcome =
  | { kind: "draft" }
  | { kind: "responded"; startedAt: number; respondedAt: number }
  | { kind: "waiting"; startedAt: number }
  | { kind: "closedWithoutResponse"; startedAt: number }
  // More comments (or reviews) exist than were fetched, none of the fetched ones is a
  // response, and no response of the other kind came before the last fetched one: an
  // unseen comment (or review) may be the first response.
  | { kind: "undetermined"; startedAt: number };

// The later of creation and the first ready-for-review event, so time spent as a
// draft doesn't count as waiting.
export function responseStart(pr: Pick<PullRequest, "createdAt" | "readyForReviewAt">): number {
  const createdAt = Date.parse(pr.createdAt);
  if (pr.readyForReviewAt === null) return createdAt;
  return Math.max(createdAt, Date.parse(pr.readyForReviewAt));
}

function latest(times: number[]): number | null {
  return times.length > 0 ? Math.max(...times) : null;
}

// For reviews and comments, the time after which some are missing: the last fetched one's
// time when GitHub has more, else null. Comments past the fetched page are all at or after
// the last fetched one. Reviews are missing when their continuation failed; GitHub orders
// them by creation, so a missing review could have been submitted a little before the last
// fetched one, a gap this ignores.
export function unfetchedAfter(pr: Pick<PullRequest, "reviews" | "comments">): {
  reviews: number | null;
  comments: number | null;
} {
  return {
    reviews: pr.reviews.pageInfo.hasNextPage
      ? latest(
          pr.reviews.nodes.flatMap((review) =>
            review.submittedAt === null ? [] : [Date.parse(review.submittedAt)],
          ),
        )
      : null,
    comments: pr.comments.pageInfo.hasNextPage
      ? latest(pr.comments.nodes.map((comment) => Date.parse(comment.createdAt)))
      : null,
  };
}

function earliest(times: number[]): number | null {
  return times.length > 0 ? Math.min(...times) : null;
}

// A response is the first submitted review (any state but PENDING; a DISMISSED review
// still shows someone responded) or conversation comment by a participant (see
// isParticipant). It must land between the start and the PR's closing: feedback on a
// draft isn't a response to the review request, and a comment after an unreviewed
// merge isn't a review.
export function classifyFirstResponse({
  pr,
  ...rules
}: { pr: PullRequest } & ParticipantRules): FirstResponseOutcome {
  // Still a draft, or closed before ever leaving draft.
  if (pr.isDraft) return { kind: "draft" };

  const startedAt = responseStart(pr);
  const closedAt = pr.state === "OPEN" || pr.closedAt === null ? null : Date.parse(pr.closedAt);
  const isInWindow = (time: number) => time >= startedAt && (closedAt === null || time <= closedAt);

  const reviewAt = earliest(
    pr.reviews.nodes.flatMap((review) => {
      if (review.state === "PENDING" || review.submittedAt === null) return [];
      if (!isParticipant(review.author, pr, rules)) return [];
      const time = Date.parse(review.submittedAt);
      return isInWindow(time) ? [time] : [];
    }),
  );
  const commentAt = earliest(
    pr.comments.nodes.flatMap((comment) => {
      const time = Date.parse(comment.createdAt);
      return isParticipant(comment.author, pr, rules) && isInWindow(time) ? [time] : [];
    }),
  );
  const respondedAt = earliest([reviewAt, commentAt].filter((time) => time !== null));

  // Unfetched reviews or comments come after the last fetched one of their kind, so they
  // can only matter when no fetched one of that kind qualified, no response came before
  // that time and the PR was still open then (inclusive, like isInWindow).
  const unfetched = unfetchedAfter(pr);
  const unseenMayRespondFirst = (found: number | null, after: number | null) =>
    found === null &&
    after !== null &&
    (closedAt === null || after <= closedAt) &&
    (respondedAt === null || respondedAt > after);
  if (
    unseenMayRespondFirst(reviewAt, unfetched.reviews) ||
    unseenMayRespondFirst(commentAt, unfetched.comments)
  ) {
    return { kind: "undetermined", startedAt };
  }

  if (respondedAt !== null) return { kind: "responded", startedAt, respondedAt };
  return pr.state === "OPEN"
    ? { kind: "waiting", startedAt }
    : { kind: "closedWithoutResponse", startedAt };
}

export function summarizeFirstResponse({
  prs,
  since,
  until,
  ...participantOptions
}: {
  prs: readonly PullRequest[];
  since?: string;
  until?: string;
} & ParticipantOptions): FirstResponseSummary {
  const rules = toParticipantRules(participantOptions);
  const responses: Array<{ startedAt: number; durationMs: number }> = [];
  const counts = { waiting: 0, closedWithoutResponse: 0, draft: 0, undetermined: 0 };

  for (const pr of prs) {
    const outcome = classifyFirstResponse({ pr, ...rules });
    switch (outcome.kind) {
      case "responded":
        responses.push({
          startedAt: outcome.startedAt,
          durationMs: outcome.respondedAt - outcome.startedAt,
        });
        break;
      case "waiting":
      case "closedWithoutResponse":
      case "draft":
      case "undetermined":
        counts[outcome.kind]++;
        break;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }

  const durations = responses.map((response) => response.durationMs).sort((a, b) => a - b);
  return {
    respondedPRs: responses.length,
    waitingPRs: counts.waiting,
    closedWithoutResponsePRs: counts.closedWithoutResponse,
    draftPRs: counts.draft,
    undeterminedPRs: counts.undetermined,
    p50Ms: roundedPercentile(durations, 0.5),
    p75Ms: roundedPercentile(durations, 0.75),
    p90Ms: roundedPercentile(durations, 0.9),
    histogram: buildHistogram(durations),
    weekly: buildWeekly({ responses, since, until }),
  };
}
