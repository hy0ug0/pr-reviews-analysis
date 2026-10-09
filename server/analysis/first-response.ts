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
  // More comments exist than were fetched, none of the fetched ones is a response,
  // and no review came before the last fetched comment: an unseen comment may be
  // the first response.
  | { kind: "undetermined"; startedAt: number };

// The later of creation and the first ready-for-review event, so time spent as a
// draft doesn't count as waiting.
export function responseStart(pr: Pick<PullRequest, "createdAt" | "readyForReviewAt">): number {
  const createdAt = Date.parse(pr.createdAt);
  if (pr.readyForReviewAt === null) return createdAt;
  return Math.max(createdAt, Date.parse(pr.readyForReviewAt));
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
  const commentTimes = pr.comments.nodes.map((comment) => Date.parse(comment.createdAt));
  const commentAt = earliest(
    pr.comments.nodes.flatMap((comment, index) =>
      isParticipant(comment.author, pr, rules) && isInWindow(commentTimes[index])
        ? [commentTimes[index]]
        : [],
    ),
  );

  // Comments past the fetched page are all at or after the last fetched one, so they
  // can only matter when no fetched comment qualified, no review came first and the
  // PR was still open at that point (inclusive, like isInWindow).
  if (commentAt === null && pr.comments.pageInfo.hasNextPage && commentTimes.length > 0) {
    const lastFetchedCommentAt = Math.max(...commentTimes);
    const unseenCanCount = closedAt === null || lastFetchedCommentAt <= closedAt;
    if (unseenCanCount && (reviewAt === null || reviewAt > lastFetchedCommentAt)) {
      return { kind: "undetermined", startedAt };
    }
  }

  const respondedAt = earliest([reviewAt, commentAt].filter((time) => time !== null));
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
