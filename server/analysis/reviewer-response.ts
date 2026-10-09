import type { Actor, PullRequest, RequestedReviewer, ReviewerStats } from "../../shared/types.ts";
import { responseStart, unfetchedAfter } from "./first-response.ts";
import {
  isParticipant,
  toParticipantRules,
  type ParticipantOptions,
  type ParticipantRules,
} from "./participants.ts";
import { roundedPercentile } from "./stats.ts";

// Per-reviewer response time: from a review request that targets a reviewer, directly or
// through one of their teams, to that reviewer's next review or conversation comment.
// Times are epoch milliseconds.

export interface ReviewerResponseSample {
  // As GitHub spells it on the response.
  login: string;
  durationMs: number;
  respondedAt: number;
}

export type ReviewerResponseStats = Pick<
  ReviewerStats,
  "responseP50Ms" | "responseP90Ms" | "responseSamples"
>;

export const NO_REVIEWER_RESPONSES: ReviewerResponseStats = {
  responseP50Ms: null,
  responseP90Ms: null,
  responseSamples: 0,
};

// Keys are lowercased logins and team slugs.
type RequestTarget = { kind: "individual"; key: string } | { kind: "team"; key: string };

type TimelineItem =
  | { kind: "requested" | "removed"; time: number; target: RequestTarget }
  | { kind: "response"; time: number; responder: Actor };

// Requests to the PR author, to bots and, with a team filter, to people outside it never get
// a response that counts, so they are skipped. With bots included, a requested bot is a
// reviewer like any other and its responses give samples, as everywhere else. A hidden reviewer
// (null) can't be credited to anyone.
function toRequestTarget(
  reviewer: RequestedReviewer | null,
  pr: Pick<PullRequest, "author">,
  rules: ParticipantRules,
): RequestTarget | null {
  if (reviewer === null) return null;
  switch (reviewer.kind) {
    case "user":
    case "bot": {
      const actor = { login: reviewer.login, __typename: reviewer.kind === "bot" ? "Bot" : "User" };
      if (!isParticipant(actor, pr, rules)) return null;
      return { kind: "individual", key: reviewer.login.toLowerCase() };
    }
    case "team":
      return { kind: "team", key: reviewer.slug.toLowerCase() };
    default: {
      const _exhaustive: never = reviewer;
      return _exhaustive;
    }
  }
}

// Unfetched reviews, comments or events come after the last fetched one of their kind. Past
// the earliest of those times an unseen review or comment could be an earlier response, or
// an unseen event a removal, so later responses can't be timed.
function horizon(pr: PullRequest): number {
  const { reviews, comments } = unfetchedAfter(pr);
  const events = pr.reviewRequests.pageInfo.hasNextPage
    ? pr.reviewRequests.nodes.map((event) => Date.parse(event.createdAt))
    : [];
  const limits = [reviews, comments, events.length > 0 ? Math.max(...events) : null];
  return Math.min(...limits.filter((limit) => limit !== null));
}

// One sample per answered request. The rules, in short:
// - A response is a submitted review (DISMISSED included: someone still responded) or a
//   conversation comment by a participant, between the response start (creation or first
//   ready-for-review) and the closing, as in first response. Draft time doesn't count: a
//   request made during the draft starts its clock when the PR becomes ready.
// - A response before any request answers nothing.
// - A pending individual request keeps its earliest start when requested again. A request
//   after the reviewer responded opens a new clock: each re-review round is a sample.
// - A removed request, or one still open at the end, gives no sample.
// - A team request is answered by the first participant to respond, timed from the team
//   request. Team membership isn't checked: it would take Team.members, the read:org scope
//   and more query cost, and the token can't see private teams.
//   A responder's own pending request takes precedence over a team's. Only someone's first
//   response after a team request can answer it: a later review by someone who passed on
//   the team request (responding on their own request) doesn't.
export function collectReviewerResponses({
  pr,
  ...rules
}: { pr: PullRequest } & ParticipantRules): ReviewerResponseSample[] {
  if (pr.isDraft) return [];

  const startedAt = responseStart(pr);
  const closedAt = pr.state === "OPEN" || pr.closedAt === null ? null : Date.parse(pr.closedAt);
  const isInWindow = (time: number) => time >= startedAt && (closedAt === null || time <= closedAt);

  const items: TimelineItem[] = [];
  for (const event of pr.reviewRequests.nodes) {
    const target = toRequestTarget(event.reviewer, pr, rules);
    if (target) items.push({ kind: event.kind, time: Date.parse(event.createdAt), target });
  }
  const responses = [
    ...pr.reviews.nodes.flatMap((review) =>
      review.state === "PENDING" || review.submittedAt === null
        ? []
        : [{ author: review.author, time: Date.parse(review.submittedAt) }],
    ),
    ...pr.comments.nodes.map((comment) => ({
      author: comment.author,
      time: Date.parse(comment.createdAt),
    })),
  ];
  for (const { author, time } of responses) {
    if (isParticipant(author, pr, rules) && isInWindow(time)) {
      items.push({ kind: "response", time, responder: author });
    }
  }
  // Stable, and events went in first: at equal times events keep GitHub's order and come
  // before responses, so a response in the same second as a request answers it.
  items.sort((a, b) => a.time - b.time);

  const samples: ReviewerResponseSample[] = [];
  const openIndividuals = new Map<string, number>();
  // In request order, so the first match is the earliest open team request.
  const openTeams = new Map<string, { start: number; seen: Set<string> }>();
  const emit = (responder: Actor, start: number, respondedAt: number) =>
    samples.push({
      login: responder.login,
      durationMs: respondedAt - Math.max(start, startedAt),
      respondedAt,
    });

  for (const item of items) {
    switch (item.kind) {
      // Asked again while pending: the first request still sets the clock.
      case "requested": {
        const { kind, key } = item.target;
        if (kind === "individual") {
          if (!openIndividuals.has(key)) openIndividuals.set(key, item.time);
        } else if (!openTeams.has(key)) {
          openTeams.set(key, { start: item.time, seen: new Set() });
        }
        break;
      }
      case "removed":
        if (item.target.kind === "individual") openIndividuals.delete(item.target.key);
        else openTeams.delete(item.target.key);
        break;
      case "response": {
        const login = item.responder.login.toLowerCase();
        const individualStart = openIndividuals.get(login);
        if (individualStart !== undefined) {
          emit(item.responder, individualStart, item.time);
          openIndividuals.delete(login);
        } else {
          const team = [...openTeams].find(([, { seen }]) => !seen.has(login));
          if (team) {
            const [key, { start }] = team;
            emit(item.responder, start, item.time);
            openTeams.delete(key);
          }
        }
        for (const { seen } of openTeams.values()) seen.add(login);
        break;
      }
      default: {
        const _exhaustive: never = item;
        return _exhaustive;
      }
    }
  }

  const limit = horizon(pr);
  return samples.filter((sample) => sample.respondedAt <= limit);
}

// Keyed by lowercased login. Samples come from every listed PR, like first response, whatever
// the date of the request or the response.
export function summarizeReviewerResponses({
  prs,
  ...participantOptions
}: { prs: readonly PullRequest[] } & ParticipantOptions): Map<string, ReviewerResponseStats> {
  const rules = toParticipantRules(participantOptions);
  const durationsByLogin = new Map<string, number[]>();
  for (const pr of prs) {
    for (const { login, durationMs } of collectReviewerResponses({ pr, ...rules })) {
      const key = login.toLowerCase();
      const durations = durationsByLogin.get(key) ?? [];
      durations.push(durationMs);
      durationsByLogin.set(key, durations);
    }
  }

  const stats = new Map<string, ReviewerResponseStats>();
  for (const [login, durations] of durationsByLogin) {
    durations.sort((a, b) => a - b);
    stats.set(login, {
      responseP50Ms: roundedPercentile(durations, 0.5),
      responseP90Ms: roundedPercentile(durations, 0.9),
      responseSamples: durations.length,
    });
  }
  return stats;
}
